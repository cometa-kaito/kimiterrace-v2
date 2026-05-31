import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * マイグレーション適用に使う最小 SQL クライアント interface。
 *
 * postgres-js の `sql`（vitest RLS テスト）と `@kimiterrace/db` の `createDbClient().sql`
 * （Playwright e2e）の両方が満たす。`postgres` を直接依存に持たないので、この module を
 * import しても driver を bundle に引き込まない（client bundle 安全）。
 */
export interface MigrationSqlClient {
  unsafe(query: string): PromiseLike<unknown>;
}

/**
 * 適用するマイグレーションファイルを「順序つき」で集める (auto-discovery)。
 *
 * **vitest の RLS テスト**と **Playwright e2e** の 2 つの DB 初期化が、同じ適用順を 1 箇所から
 * 得るための共有実装。並行レーンが loader を奪い合わない (docs/parallel-lanes.md §4 の chokepoint
 * 解消) よう、ハードコードした const 列ではなく **ディレクトリ走査 + ファイル名昇順** で集める。
 * 新しい migration は drizzle/ か migrations/ に番号 (または timestamp) prefix で置くだけで、
 * どちらの loader も編集せずに拾う。
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
 *
 * @param root `@kimiterrace/db` パッケージのルート (drizzle/ と migrations/ を含むディレクトリ)。
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
 * SQL ファイルを 1 つ適用する。
 *
 * - drizzle 生成ファイルは `--> statement-breakpoint` を分割境界に使う。
 * - 手書き SQL は `splitSqlStatements` で `;` 分割するが、`$$ ... $$` (PL/pgSQL 関数本体) や
 *   `'...'` リテラル、`--` 行コメント中の `;` は無視する (PR #130 Reviewer L1)。
 */
export async function runMigrationFile(sql: MigrationSqlClient, path: string): Promise<void> {
  const raw = readFileSync(path, "utf-8");
  if (raw.includes("--> statement-breakpoint")) {
    for (const stmt of raw.split("--> statement-breakpoint")) {
      const trimmed = stmt.trim();
      if (trimmed.length > 0) {
        await sql.unsafe(trimmed);
      }
    }
  } else {
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
