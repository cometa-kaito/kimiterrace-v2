import type { TenantRole } from "@kimiterrace/db";
import { cookies } from "next/headers";
import { cache } from "react";
import { getAdminAuth } from "./adminApp";

/**
 * Identity Platform セッション cookie の発行・検証 (ADR-003)。
 *
 * **このモジュールはサーバー専用** (firebase-admin / next/headers を使う)。クライアント
 * コンポーネントから import しないこと。Route Handler / Server Component / Server Action 経由でのみ使う。
 *
 * 設計上の不変条件:
 * - **deny-by-default**: 検証失敗・期限切れ・claims 不正は **null** を返す (throw しない)。
 *   呼出側 (middleware / Server Component / `withSession`) が null を 401/redirect に変換する。
 * - **claims の値域検証 (PR #133 Reviewer Low-1)**: `uid` / `school_id` は UUID 形式、`role` は
 *   Drizzle の `userRole` enum + `system_admin` (= `TenantRole`) のみ許可。不正値は null に倒し、
 *   RLS コンテキスト (ADR-019) に汚染値が流れ込むのを防ぐ。
 * - **型の単一ソース (CLAUDE.md ルール3)**: role の型は `@kimiterrace/db` の `TenantRole` を
 *   import する (型のみ = ビルド時に消去)。許可値の配列 `ALLOWED_ROLES` は、`@kimiterrace/db` の
 *   ランタイム値 (`userRole.enumValues`) を Next バンドルに引き込まないため**ローカル宣言**するが、
 *   `satisfies readonly TenantRole[]` + 全網羅チェックで **enum とのズレをコンパイル時に検出**する
 *   (enum に値が増えたら型エラー)。手書きユニオンの二重管理 (ルール3 NG) ではなく、型による単一ソース。
 *
 * 注: `@kimiterrace/db` の index は内部 re-export に `.js` 拡張子を使い、Next のバンドラが
 * ランタイム値を解決できない (build が落ちる)。型のみ import に留めることで回避している。
 */

/**
 * RLS コンテキストに載せうる全ロール (`TenantRole` と一致)。
 * 下の `_exhaustive` 代入で、`TenantRole` の全メンバが網羅されていることをコンパイル時に保証する。
 */
const ALLOWED_ROLES = [
  "school_admin",
  "teacher",
  "student",
  "guardian",
  "system_admin",
] as const satisfies readonly TenantRole[];

// ズレ検出: TenantRole の全メンバが ALLOWED_ROLES に含まれることを型レベルで強制する。
// userRole enum に値が追加され TenantRole が広がると、この代入が型エラーになる (= 更新漏れを CI が検出)。
type _ExhaustiveRoleCheck =
  Exclude<TenantRole, (typeof ALLOWED_ROLES)[number]> extends never ? true : never;
const _exhaustive: _ExhaustiveRoleCheck = true;
void _exhaustive;

/** 認証済みユーザーの最小コンテキスト。RLS の SET LOCAL (ADR-019) にそのまま流せる形。 */
export type AuthUser = {
  uid: string;
  role: TenantRole;
  /** system_admin は school に属さないため null になりうる (テナント外、ADR-019)。 */
  schoolId: string | null;
  /** Identity Platform メールアドレス。ヘッダ表示用。セキュリティ判断には使わない。 */
  email?: string;
};

/** session cookie 検証時に取り出す生の custom claims (検証前)。 */
type RawClaims = {
  uid?: unknown;
  role?: unknown;
  school_id?: unknown;
};

// RFC 4122 の UUID 形式 (8-4-4-4-12 hex)。バージョン桁は緩めに許可 (gen_random_uuid は v4)。
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ALLOWED_ROLE_SET = new Set<string>(ALLOWED_ROLES);

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function toTenantRole(value: unknown): TenantRole | null {
  if (typeof value !== "string") {
    return null;
  }
  if (ALLOWED_ROLE_SET.has(value)) {
    return value as TenantRole;
  }
  return null;
}

/**
 * 検証済み claims を AuthUser に正規化する。1 つでも不正なら null (deny-by-default)。
 *
 * - `uid` は UUID 必須 (users.id / system_admins.id は uuid)。**`decoded.uid` は firebase-admin が
 *   常に Auth の localId (= ID トークンの `sub`) を返す**。`uid` という名の custom claim は予約衝突で
 *   無視される (#224 で実証) ため、DB の id を claim に載せる経路は存在しない → Identity Platform
 *   ユーザーの **localId 自体を `users.id`(UUID) に一致させて provisioning する**のが前提 (ADR-003)。
 * - `role` は TenantRole のみ (特権 SA が付与する custom claim)。
 * - `school_id` は system_admin のとき null 許容、それ以外は UUID 必須 (custom claim)。
 *   テナントロールで school_id が無い / 不正なら deny (RLS が school_id 未設定で全件拒否になる前に倒す)。
 */
function normalizeClaims(claims: RawClaims): AuthUser | null {
  const role = toTenantRole(claims.role);
  if (!role) {
    return null;
  }

  if (!isUuid(claims.uid)) {
    return null;
  }
  const uid = claims.uid;

  if (role === "system_admin") {
    // system_admin は school_id を持たない。万一付いていても無視せず、付くなら正しい UUID を要求する。
    const sid = claims.school_id;
    if (sid !== undefined && sid !== null && !isUuid(sid)) {
      return null;
    }
    return { uid, role, schoolId: isUuid(sid) ? sid : null };
  }

  // テナントロール (school_admin / teacher / student / guardian) は school_id 必須。
  if (!isUuid(claims.school_id)) {
    return null;
  }
  return { uid, role, schoolId: claims.school_id };
}

/**
 * ID トークンから session cookie を発行する (Admin SDK)。
 * @param idToken Identity Platform クライアント SDK でサインインして得た ID トークン
 * @param expiresInMs cookie の有効期間 (ミリ秒)。Identity Platform は 5分〜14日を許容。
 */
export async function createSessionCookie(idToken: string, expiresInMs: number): Promise<string> {
  return await getAdminAuth().createSessionCookie(idToken, { expiresIn: expiresInMs });
}

/**
 * session cookie を検証し、検証済みトークン (localId + custom claims) を AuthUser に正規化して返す。
 * 失敗・期限切れ・claims 不正はすべて **null** (deny-by-default、throw しない)。
 *
 * @param cookie session cookie の値
 * @param checkRevoked true で失効チェック (毎回の検証で失効済みトークンを拒否、ADR-003 の二重チェック思想)。
 *   **既定の `true` を無効化しないこと (ADR-026 D1)**: アカウント無効化 / ロール変更は
 *   `revokeRefreshTokens` で失効を確定させ、この既定がそれを拒否に変換してエンフォースする。`false` 既定に
 *   倒すと無効化が効かなくなる (security theater)。既定値は session.test.ts (#139 L4) で pin 済。
 */
export async function verifySessionCookie(
  cookie: string,
  checkRevoked = true,
): Promise<AuthUser | null> {
  if (!cookie) {
    return null;
  }
  try {
    const decoded = await getAdminAuth().verifySessionCookie(cookie, checkRevoked);
    // `decoded.uid` は Auth localId (= ID トークン sub) であり custom claim ではない。
    // `role` / `school_id` は特権 SA が付与する custom claim。localId を users.id(UUID) に
    // 一致させる provisioning 前提は normalizeClaims の docstring を参照 (ADR-003)。
    const authUser = normalizeClaims({
      uid: decoded.uid,
      role: decoded.role,
      school_id: decoded.school_id,
    });
    if (!authUser) return null;
    // email は表示用途のみ。存在しない場合はフィールド自体を省略し既存 toEqual テストを壊さない。
    return decoded.email ? { ...authUser, email: decoded.email } : authUser;
  } catch {
    // 改竄・期限切れ・失効はすべて deny。例外内容はログに出さない (secret/トークン断片の漏洩防止、ルール5)。
    return null;
  }
}

/**
 * session cookie 名。Identity Platform の慣例に従い `__session` を使う
 * (Firebase Hosting / Cloud CDN がキャッシュ対象から除外する予約名)。
 * Route Handler 側 (発行・破棄) と middleware (存在チェック) で同じ名前を使う。
 */
const SESSION_COOKIE_NAME = "__session";

/**
 * 現在のリクエストの session cookie を読み、検証済み AuthUser を返す。未認証は null。
 *
 * Server Component / Route Handler / Server Action から呼ぶ (Edge middleware からは呼ばない:
 * firebase-admin は Edge runtime 非対応。middleware は cookie 存在チェックのみ、ADR-003)。
 *
 * **React `cache()` でラップ (PR #1037 Reviewer nit-1)**: 多層防御で同一リクエスト内に
 * `requireRole` / `requireUser` が複数回呼ばれる箇所 (例: レイアウト + ページ、ページ + 委譲先 View、
 * editor scope ページ群) があり、その都度 `verifySessionCookie(cookie, checkRevoked=true)` =
 * Identity Platform へのリモート失効チェック往復が走る。`cache()` で **1 リクエスト内の再呼び出しを
 * メモ化**し、検証往復を 1 回に畳む。
 *
 * **失効反映が遅れる副作用は無い (認可判定の核なので要確認事項)**: React `cache()` のメモ化スコープは
 * **Next.js が RSC リクエストごとに張る境界に閉じる**。リクエストを跨いだ永続キャッシュではないため、
 * `revokeRefreshTokens` による失効は次リクエストの検証で即座に反映される (ADR-026 D1 の保証は不変)。
 * メモ化はあくまで「同一リクエスト内で同じ user を返す」= 既に冪等な振る舞いの最適化に留まる。
 * リクエストスコープ外 (unit テスト等、Next ランタイム非経由) では `cache()` は素通し
 * (メモ化されず毎回実行) になり、横断的キャッシュにはならない。
 */
export const getCurrentUser = cache(async (): Promise<AuthUser | null> => {
  const cookieStore = await cookies();
  const cookie = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!cookie) {
    return null;
  }
  return await verifySessionCookie(cookie);
});

export { SESSION_COOKIE_NAME };
