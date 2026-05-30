import {
  type KimiterraceDb,
  type TenantTx,
  createDbClient,
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
 * 現在のセッションを解決し、RLS context を張ったトランザクション内で `fn` を実行する。
 *
 * - `getCurrentUser()` が null (未認証 / claims 不正) なら `UnauthenticatedError` を投げる
 *   (deny-by-default)。
 * - 非 null なら `withTenantContext` (packages/db) に user を渡して `SET LOCAL` 相当を一元処理。
 *   手書きの SET LOCAL は書かない (ADR-008 一元化 / ADR-019)。
 *
 * @throws {UnauthenticatedError} 未認証時
 */
export async function withSession<T>(fn: (tx: TenantTx, user: AuthUser) => Promise<T>): Promise<T> {
  const user = await getCurrentUser();
  if (!user) {
    throw new UnauthenticatedError();
  }
  return await withTenantContext(
    getDb(),
    { userId: user.uid, schoolId: user.schoolId, role: user.role },
    (tx) => fn(tx, user),
  );
}
