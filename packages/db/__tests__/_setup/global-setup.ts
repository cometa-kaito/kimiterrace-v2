import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, "..", "..");

/**
 * 適用するマイグレーションファイルを「順序つき」で集める (auto-discovery)。
 *
 * 並行レーンが loader を奪い合わない (docs/parallel-lanes.md §4 の chokepoint 解消) ため、
 * ハードコードした const 列ではなく **ディレクトリ走査 + ファイル名昇順** で集める。新しい
 * migration は drizzle/ か migrations/ に番号 (または timestamp) prefix で置くだけで、この
 * loader を編集せずに拾われる (= loader が並行 PR の衝突点でなくなる)。
 *
 * 順序契約 (本番 runbook docs/runbooks/db-migrations.md が参照する単一ソース):
 *   1. drizzle/*.sql    — drizzle-kit 生成の DDL をファイル名昇順で全て
 *   2. migrations/*.sql — 手書き RLS / トリガ / VIEW / SECURITY DEFINER 関数をファイル名昇順で全て
 *
 * **ファイル名昇順 == 依存順** になるよう採番する (後から依存するものほど大きい番号)。依存理由は
 * 各ファイル先頭コメントに書く。例: effective_ads_view (0011) と resolve_magic_link 関数 (0012) は
 * RLS (0001-0010) 適用後に流す必要があるため、生成時期より大きい番号を振っている。`0000..0010` の
 * 既存番号は timestamp prefix より小さくソートされるので、将来 timestamp 採番へ移行しても
 * 「既存が先・新規が後」の不変条件は保たれる。
 */
export function collectMigrationFiles(root: string): string[] {
  const listSqlSorted = (dir: string): string[] =>
    readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => join(dir, f));
  return [...listSqlSorted(join(root, "drizzle")), ...listSqlSorted(join(root, "migrations"))];
}

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
 * - 拡張 → `collectMigrationFiles()` が返す順 (drizzle DDL → 手書き RLS/トリガ/VIEW/関数) で全て流す
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

    // 3) マイグレーションを順に適用する。順序の単一ソースは collectMigrationFiles
    //    (drizzle/ の DDL をファイル名順 → migrations/ の RLS/トリガ/VIEW/SECURITY DEFINER 関数を
    //    ファイル名順)。本番も同じ順で両ディレクトリを適用する (docs/runbooks/db-migrations.md)。
    //    依存順 == ファイル名昇順 になるよう採番しているので、ここは編集不要で新 migration を拾う。
    for (const file of collectMigrationFiles(packageRoot)) {
      await runSqlFile(sql, file);
    }
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
 *
 * `--` 行コメントは (文字列/関数本体の外なら) 行末まで読み飛ばす。これをしないと
 * コメント中の `'` や `;` を SQL トークンとして誤認し、奇数個のアポストロフィを含む
 * コメントが後続の `;` を見落とさせて statement を silent に欠落させる脆さがある
 * (PR #130 Reviewer L1)。
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

    // 行コメント (文字列/関数本体の外のみ): 行末まで捨てる。改行は残して
    // トークンが結合しないようにする。
    if (!inDollar && !inSingle && next2 === "--") {
      const nl = sql.indexOf("\n", i);
      if (nl === -1) {
        i = sql.length;
      } else {
        buf += "\n";
        i = nl + 1;
      }
      continue;
    }

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
