import type { TenantRole } from "@kimiterrace/db";
import { cookies } from "next/headers";
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
type _ExhaustiveRoleCheck = Exclude<TenantRole, (typeof ALLOWED_ROLES)[number]> extends never
  ? true
  : never;
const _exhaustive: _ExhaustiveRoleCheck = true;
void _exhaustive;

/** 認証済みユーザーの最小コンテキスト。RLS の SET LOCAL (ADR-019) にそのまま流せる形。 */
export type AuthUser = {
  uid: string;
  role: TenantRole;
  /** system_admin は school に属さないため null になりうる (テナント外、ADR-019)。 */
  schoolId: string | null;
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
 * - `uid` は UUID 必須 (users.id / system_admins.id は uuid。Identity Platform 側で
 *   custom claim `uid` に DB の user id を載せる運用、ADR-003)。
 * - `role` は TenantRole のみ。
 * - `school_id` は system_admin のとき null 許容、それ以外は UUID 必須。
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
 * session cookie を検証し、custom claims を AuthUser に正規化して返す。
 * 失敗・期限切れ・claims 不正はすべて **null** (deny-by-default、throw しない)。
 *
 * @param cookie session cookie の値
 * @param checkRevoked true で失効チェック (毎回の検証で失効済みトークンを拒否、ADR-003 の二重チェック思想)
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
    return normalizeClaims({
      uid: decoded.uid,
      role: decoded.role,
      school_id: decoded.school_id,
    });
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
 */
export async function getCurrentUser(): Promise<AuthUser | null> {
  const cookieStore = await cookies();
  const cookie = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!cookie) {
    return null;
  }
  return await verifySessionCookie(cookie);
}

export { SESSION_COOKIE_NAME };
