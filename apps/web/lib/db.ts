import {
  type KimiterraceDb,
  type TenantRole,
  type TenantTx,
  createDbClient,
  tenantScopedContext,
  withTenantContext,
} from "@kimiterrace/db";
import { type AuthUser, getCurrentUser } from "./auth/session";

/**
 * 認証 → RLS コンテキスト配線 (ADR-019 二層 RLS / ADR-008 一元化 / ADR-003 認証)。
 *
 * - `getDb()`: アプリ標準 DB クライアントのシングルトン。
 * - `withSession(fn)`: 現在のセッションから user を解決し、RLS context を張ったトランザクションで
 *   `fn` を実行する。未認証は **deny** (throw)。
 *
 * **接続ロール (CLAUDE.md ルール2)**: `getDb()` が使う接続は **非 BYPASSRLS** ロール
 * (`kimiterrace_app`) であること。BYPASSRLS ロールでは RLS が効かずテナント越境する。
 * 接続 URL に含めるユーザーは migration 用 (`migrator`) と分離する。
 */

/**
 * DB 接続 URL を解決する。
 *
 * **CLAUDE.md ルール5 (Secret Manager)**: 接続 URL は DB 認証情報 (= シークレット) を含む。
 * - **本番 (Cloud Run)**: Secret Manager に格納した値を Workload Identity 経由で取得し、
 *   起動時に `DATABASE_URL` env へ注入する (Cloud Run の secret mount。JSON キー禁止)。
 * - **ローカル / テスト (ADR-012)**: `.env.local` / CI env の `DATABASE_URL` (実 PG)。
 *
 * いずれの経路でもプロセス env 経由で受け取るが、**コードや通常の (コミットされる) env に
 * URL をハードコードしない**。`.env*` は .gitignore 済み、`.env.example` は placeholder のみ。
 */
function resolveDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. 本番は Secret Manager 経由で注入、ローカル/テストは .env.local / CI env で設定する (CLAUDE.md ルール5 / ADR-012)。",
    );
  }
  return url;
}

let cached: { sql: ReturnType<typeof createDbClient>["sql"]; db: KimiterraceDb } | null = null;

/**
 * アプリ標準の Drizzle クライアント (シングルトン) を返す。
 * Cloud Run の 1 インスタンス内で接続プールを使い回す (createDbClient は max:10 のプール)。
 */
export function getDb(): KimiterraceDb {
  if (cached) {
    return cached.db;
  }
  cached = createDbClient(resolveDatabaseUrl());
  return cached.db;
}

/** 未認証時に投げるエラー。呼出側 (Route Handler / Server Action) が 401 / redirect に変換する。 */
export class UnauthenticatedError extends Error {
  constructor() {
    super("認証されていません (session cookie 無し / 無効)。");
    this.name = "UnauthenticatedError";
  }
}

/**
 * 認証済みだが role が許可集合に無いときに投げるエラー。
 * 呼出側 (Route Handler) が 403 に変換する (Server Component は `requireRole` で redirect する)。
 *
 * `teacher_inputs` のように RLS が school 境界しか守らないテーブルでは、role 境界をこの層で
 * 強制する必要がある (ルール2 多層防御の第一層)。`allowedRoles` 指定時のみ評価され、
 * 未指定の既存呼出 (publish/schedule/hub Server Action は別途 `requireRole` でガード済) は
 * 従来どおり role を問わない (後方互換)。
 */
export class ForbiddenError extends Error {
  constructor() {
    super("権限がありません (role が許可されていません)。");
    this.name = "ForbiddenError";
  }
}

/**
 * 現在のセッションを解決し、RLS context を張ったトランザクション内で `fn` を実行する。
 *
 * - `getCurrentUser()` が null (未認証 / claims 不正) なら `UnauthenticatedError` を投げる
 *   (deny-by-default)。
 * - `options.allowedRoles` を渡すと、user.role がそこに無い場合 `ForbiddenError` を投げる
 *   (tx を開く前に弾く)。RLS が role 境界を守らないテーブルの認可第一層。
 * - `options.tenantScoped` を渡すと、特定 school を対象にする mutation 用に **system_admin を
 *   tenant ロールへ降格** する (ADR-019 §#95 / Issue #197)。`system_admin_full_access` policy の
 *   全校発火を止め、cross-tenant 越権 (自校可視性チェックのすり抜け、#73) を DB レベルで封じる。
 *   全校横断が必要な経路 (system_admin の学校一覧 #48-L 等) は **指定しない** ことで従来どおり
 *   全校可視を保つ (opt-in、後方互換)。降格条件・理由は `tenantScopedContext` を参照。
 * - 非 null なら `withTenantContext` (packages/db) に user を渡して `SET LOCAL` 相当を一元処理。
 *   手書きの SET LOCAL は書かない (ADR-008 一元化 / ADR-019)。
 *
 * @throws {UnauthenticatedError} 未認証時
 * @throws {ForbiddenError} `allowedRoles` 指定かつ role が許可集合に無いとき
 */
export async function withSession<T>(
  fn: (tx: TenantTx, user: AuthUser) => Promise<T>,
  options?: { allowedRoles?: readonly TenantRole[]; tenantScoped?: boolean },
): Promise<T> {
  const user = await getCurrentUser();
  if (!user) {
    throw new UnauthenticatedError();
  }
  if (options?.allowedRoles && !options.allowedRoles.includes(user.role)) {
    throw new ForbiddenError();
  }
  const baseContext = { userId: user.uid, schoolId: user.schoolId, role: user.role };
  const context = options?.tenantScoped ? tenantScopedContext(baseContext) : baseContext;
  return await withTenantContext(getDb(), context, (tx) => fn(tx, user));
}

/**
 * **既に解決済みの `AuthUser`** で RLS context tx を開く (`withSession` の「user 既知」版)。
 *
 * `withSession` は毎回 `getCurrentUser()` で cookie を再検証する (失効チェックで Identity Platform への
 * 往復を伴う)。同一リクエスト内で既に user を解決済みの呼び出し (例: 認可ガードが弾いた後の監査記録) では、
 * その再検証は冗長で、敵対的経路 (拒否試行の連打) では IdP 負荷を二重化する。本関数は解決済み user を
 * そのまま `withTenantContext` に渡し、二度目の検証を避ける。
 *
 * 注: caller が `user` の正当性を保証する責務を持つ (本関数は cookie 検証も role gate もしない)。
 * 通常の画面/API 経路は引き続き `withSession` を使うこと。
 */
export async function withUserSession<T>(
  user: AuthUser,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  return await withTenantContext(
    getDb(),
    { userId: user.uid, schoolId: user.schoolId, role: user.role },
    fn,
  );
}
