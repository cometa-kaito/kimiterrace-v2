import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { collectMigrationFiles, runMigrationFile } from "../../src/migrate-files";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, "..", "..");

/**
 * `DATABASE_URL` を test-DB として安全に使えるか検証する (H1 ガード)。
 *
 * `DROP SCHEMA public CASCADE` が prod / staging DB に間違って当たると 1 サイクルで
 * 学校データが消える footgun。以下のいずれかを満たさない限り abort する:
 *   1. 環境変数 `KIMITERRACE_TEST_DB_OK=1` が明示設定されている (CI で正攻法)
 *   2. ホストが localhost / 127.0.0.1 / host.docker.internal (ローカル PG)
 *   3. DB 名が "test" / "_test" / "kimiterrace_test" を含む (パターン)
 *
 * いずれも該当しない場合は throw して setup 失敗 → 全テストが abort する。
 */
function assertTestDatabase(url: string): void {
  if (process.env.KIMITERRACE_TEST_DB_OK === "1") return;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      "[rls-tests] DATABASE_URL が URL として解釈できません。RLS テストを安全に走らせるには " +
        "`postgresql://...` 形式の文字列が必要です。",
    );
  }

  const host = parsed.hostname.toLowerCase();
  const localHosts = new Set(["localhost", "127.0.0.1", "::1", "host.docker.internal"]);
  if (localHosts.has(host)) return;

  // path は "/dbname" — 先頭スラッシュを落として比較
  const dbName = parsed.pathname.replace(/^\//, "").toLowerCase();
  if (/test/.test(dbName)) return;

  throw new Error(
    `[rls-tests] DATABASE_URL が test-DB と判定できません (host=${host}, db=${dbName})。 DROP SCHEMA CASCADE 実行を拒否しました。 明示的に test DB であることを示すため、 (a) DB 名に 'test' を含める、(b) ホストを localhost 系にする、 (c) 環境変数 KIMITERRACE_TEST_DB_OK=1 を設定する、のいずれかを行ってください。`,
  );
}

/**
 * Vitest globalSetup: テスト前に DATABASE_URL の DB を初期化する。
 *
 * - 既存スキーマを `DROP SCHEMA public CASCADE` で破棄 (テスト DB 限定の前提)
 * - 拡張 → `collectMigrationFiles()` が返す順 (drizzle DDL → 手書き RLS/トリガ/VIEW/関数) で全て流す。
 *   適用順の真実ソースは `src/migrate-files.ts` (e2e の Playwright globalSetup と共有)。
 * - DATABASE_URL 未設定の場合はテスト自体をスキップ (== 全テストが skip 扱い)
 */
export async function setup(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.warn(
      "[rls-tests] DATABASE_URL が未設定のため RLS テストをスキップします。" +
        " docker compose up -d postgres を実行し DATABASE_URL を設定してください。",
    );
    process.env.RLS_TESTS_SKIP = "1";
    return;
  }

  // H1: prod / staging DB 誤接続防止ガード (Issue #96)
  assertTestDatabase(url);

  // superuser 接続 (拡張作成と DROP SCHEMA を行うため)
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    // 1) クリーンスレートにする (テスト用 DB 限定の前提 — assertTestDatabase で保証済)
    await sql.unsafe("DROP SCHEMA IF EXISTS public CASCADE;");
    await sql.unsafe("CREATE SCHEMA public;");
    // pg 拡張は schema 横断なので明示再付与
    await sql.unsafe("GRANT ALL ON SCHEMA public TO public;");

    // 2) 拡張 (pgvector + pgcrypto)
    await sql.unsafe("CREATE EXTENSION IF NOT EXISTS vector;");
    await sql.unsafe("CREATE EXTENSION IF NOT EXISTS pgcrypto;");

    // 3) マイグレーションを順に適用する。適用順の単一ソースは collectMigrationFiles
    //    (drizzle/ の DDL をファイル名順 → migrations/ の RLS/トリガ/VIEW/SECURITY DEFINER 関数を
    //    ファイル名順)。本番も同じ順で両ディレクトリを適用する (docs/runbooks/db-migrations.md)。
    //    依存順 == ファイル名昇順 になるよう採番しているので、新 migration は編集不要で拾われる。
    for (const file of collectMigrationFiles(packageRoot)) {
      await runMigrationFile(sql, file);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export async function teardown(): Promise<void> {
  // テスト DB の中身は次回 setup で破棄されるためここでは何もしない
}
