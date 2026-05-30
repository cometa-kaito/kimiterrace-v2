import { sql } from "drizzle-orm";
import { type PostgresJsDatabase, drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { userRole } from "./_shared/enums.js";

/**
 * RLS テナントコンテキスト ヘルパ (#48-B core)。
 *
 * ADR-019 (RLS 二層分離) が前提とする「接続/トランザクションごとに
 * `app.current_user_id` / `app.current_school_id` / `app.current_user_role` を
 * `SET LOCAL` 相当で張る」処理を 1 箇所に集約する。
 *
 * これにより呼び出し側 (middleware #48-B auth / サイネージ #48-E / クエリ層 #48-F) は
 * 「素の SET LOCAL を手書きしない」=「設定漏れによるテナント越境のリスクを構造的に避ける」
 * (ADR-008 の API 一元化方針 + CLAUDE.md ルール2)。
 *
 * 設計上の不変条件:
 * - **deny-by-default**: ctx の値が未指定/null のキーは set_config せず、RLS 側で
 *   `current_setting(..., true)` が NULL → 全件拒否になる (ADR-019 適用ルール2)。
 * - **トランザクションスコープ**: `set_config(..., true)` は is_local=true のため、
 *   トランザクション終了で自動的に消える。コネクションプール再利用時に別ユーザーへ
 *   混入しない (ADR-019 §悪い影響「SET LOCAL の漏れリスク」への構造的対策)。
 * - **RLS をバイパスしない接続で使う**: db には `kimiterrace_app` 等の非 BYPASSRLS
 *   ロールで接続したクライアントを渡すこと。BYPASSRLS ロールでは RLS が効かない。
 */

/** アプリ標準の Drizzle (postgres-js) クライアント型。 */
export type KimiterraceDb = PostgresJsDatabase<Record<string, never>>;

/** `withTenantContext` のコールバックが受け取るトランザクション型。 */
export type TenantTx = Parameters<Parameters<KimiterraceDb["transaction"]>[0]>[0];

/**
 * RLS コンテキストに載せるロール。
 * テナント内ロールは Drizzle の `userRole` enum を単一ソースとし (CLAUDE.md ルール3)、
 * テナント外の `system_admin` のみ手で追加する (system_admins は別テーブル管理のため
 * enum には含まれない)。
 */
export type TenantRole = (typeof userRole.enumValues)[number] | "system_admin";

/** RLS コンテキスト。未指定/null のキーは set_config されず deny-by-default になる。 */
export type TenantContext = {
  userId?: string | null;
  schoolId?: string | null;
  role?: TenantRole | null;
};

export type WithTenantContextOptions = {
  /**
   * 接続が BYPASSRLS な特権ロール (テスト superuser 等) の場合に、トランザクション内で
   * アプリロールへ降格するための `SET LOCAL ROLE` 先。本番は最初から `kimiterrace_app` で
   * 接続するため未指定でよい。
   */
  appRole?: string;
};

// SET LOCAL ROLE はロール名をバインドパラメータにできないため、識別子として安全な文字のみ許可。
// appRole は呼び出しコード側で固定指定する想定 (ユーザー入力を渡さない) だが、多層防御として検証する。
const SAFE_ROLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * アプリ標準の DB クライアントを生成する。
 *
 * url には認証情報が含まれる (= シークレット) ため、本番では Secret Manager 経由で
 * 取得した値を渡すこと (CLAUDE.md ルール5)。コード/環境変数へのハードコード禁止。
 * テストでは ADR-012 に従い `DATABASE_URL` env (実 PG) を渡す。
 */
export function createDbClient(url: string): {
  sql: ReturnType<typeof postgres>;
  db: KimiterraceDb;
} {
  const sqlClient = postgres(url, { max: 10, onnotice: () => {} });
  return { sql: sqlClient, db: drizzle(sqlClient) };
}

/**
 * RLS コンテキストを張ったトランザクション内で `fn` を実行する。
 *
 * @param db   非 BYPASSRLS ロールで接続した Drizzle クライアント
 * @param ctx  テナントコンテキスト (未指定キーは deny-by-default)
 * @param fn   トランザクションを受け取り結果を返すコールバック
 * @returns    `fn` の戻り値
 */
export async function withTenantContext<T>(
  db: KimiterraceDb,
  ctx: TenantContext,
  fn: (tx: TenantTx) => Promise<T>,
  options: WithTenantContextOptions = {},
): Promise<T> {
  const { appRole } = options;
  if (appRole !== undefined && !SAFE_ROLE_NAME.test(appRole)) {
    throw new Error(`withTenantContext: 不正な appRole 名: ${JSON.stringify(appRole)}`);
  }

  return await db.transaction(async (tx) => {
    if (appRole !== undefined) {
      await tx.execute(sql.raw(`SET LOCAL ROLE ${appRole}`));
    }
    // deny-by-default: null/undefined/空文字 は set_config しない (未設定 → RLS で全件拒否)。
    // 空文字を弾くのは多層防御: policy 側 NULLIF(...,'') でも deny に正規化されるが、
    // primitive 自身が「空文字 = 未設定」として扱い、下流の正規化に依存しない (PR #133 Reviewer Low-1)。
    if (ctx.userId) {
      await tx.execute(sql`select set_config('app.current_user_id', ${ctx.userId}, true)`);
    }
    if (ctx.schoolId) {
      await tx.execute(sql`select set_config('app.current_school_id', ${ctx.schoolId}, true)`);
    }
    if (ctx.role) {
      await tx.execute(sql`select set_config('app.current_user_role', ${ctx.role}, true)`);
    }
    return await fn(tx);
  });
}
