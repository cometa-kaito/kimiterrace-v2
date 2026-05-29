import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, "..", "..");

const BASELINE_SQL = join(packageRoot, "drizzle", "0000_initial_baseline.sql");
const RLS_ENABLE_SQL = join(packageRoot, "migrations", "0001_enable_rls.sql");
const RLS_POLICIES_SQL = join(packageRoot, "migrations", "0002_rls_policies.sql");
const AUDIT_TRIGGER_SQL = join(packageRoot, "migrations", "0003_audit_trigger.sql");
const AUDIT_FK_SQL = join(packageRoot, "migrations", "0004_audit_fk.sql");
const AUDIT_LOG_ACTOR_NULL_SQL = join(
  packageRoot,
  "migrations",
  "0005_audit_log_actor_null_school_admin.sql",
);

/**
 * Vitest globalSetup: テスト前に DATABASE_URL の DB を初期化する。
 *
 * - 既存スキーマを `DROP SCHEMA public CASCADE` で破棄 (テスト DB 限定の前提)
 * - 拡張 → drizzle baseline DDL → RLS 有効化 → policy → audit trigger を順に流す
 * - DATABASE_URL 未設定の場合はテスト自体をスキップ (== 全テストが skip 扱い)
 */
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

    // 3) DDL (drizzle 生成済の baseline)
    await runSqlFile(sql, BASELINE_SQL);

    // 4) RLS 有効化 + policy + audit トリガ + 監査 FK (created_by / updated_by → users.id)
    //    + audit_log_insert で school_admin の actor=NULL を拒否 (Issue #105)
    await runSqlFile(sql, RLS_ENABLE_SQL);
    await runSqlFile(sql, RLS_POLICIES_SQL);
    await runSqlFile(sql, AUDIT_TRIGGER_SQL);
    await runSqlFile(sql, AUDIT_FK_SQL);
    await runSqlFile(sql, AUDIT_LOG_ACTOR_NULL_SQL);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export async function teardown(): Promise<void> {
  // テスト DB の中身は次回 setup で破棄されるためここでは何もしない
}

async function runSqlFile(sql: ReturnType<typeof postgres>, path: string): Promise<void> {
  const raw = readFileSync(path, "utf-8");
  // drizzle の statement-breakpoint コメントを分割境界として使う。
  // 手書きの 0001/0002/0003 にはコメントが無いので、まとめて 1 ステートメントとして
  // 実行可能 (CREATE POLICY / DROP POLICY を独立に流すには分割が必要なため、
  // ';' 単純分割で対応する)。
  if (raw.includes("--> statement-breakpoint")) {
    for (const stmt of raw.split("--> statement-breakpoint")) {
      const trimmed = stmt.trim();
      if (trimmed.length > 0) {
        await sql.unsafe(trimmed);
      }
    }
  } else {
    // 関数本体 ($$ ... $$) を保護した分割
    for (const stmt of splitSqlStatements(raw)) {
      const trimmed = stmt.trim();
      if (trimmed.length > 0) {
        await sql.unsafe(trimmed);
      }
    }
  }
}

/**
 * `;` で SQL を分割するが、`$$ ... $$` (PL/pgSQL 関数本体) や `'...'` リテラルの中の
 * `;` は無視する。プレーンな `;` 区切りより安全。
 */
function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = "";
  let i = 0;
  let inDollar = false;
  let inSingle = false;
  while (i < sql.length) {
    const ch = sql[i];
    const next2 = sql.slice(i, i + 2);

    if (!inSingle && next2 === "$$") {
      inDollar = !inDollar;
      buf += next2;
      i += 2;
      continue;
    }

    if (!inDollar && ch === "'") {
      // '' (escaped quote) はトグルしない
      if (inSingle && sql[i + 1] === "'") {
        buf += "''";
        i += 2;
        continue;
      }
      inSingle = !inSingle;
      buf += ch;
      i += 1;
      continue;
    }

    if (!inDollar && !inSingle && ch === ";") {
      out.push(buf);
      buf = "";
      i += 1;
      continue;
    }

    buf += ch;
    i += 1;
  }
  if (buf.trim().length > 0) {
    out.push(buf);
  }
  return out;
}
