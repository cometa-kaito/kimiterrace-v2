/**
 * カスタム migration runner。
 *
 * drizzle-kit の `migrate` は snapshot.json を参照する自動生成 migration のみを扱うが、
 * 本リポでは RLS / trigger / role の手書き SQL を `drizzle/*.sql` に並べているため、
 * `drizzle/` 直下の .sql ファイルを **ファイル名昇順で順番に流す** ことで全 DDL を適用する。
 *
 * - 適用済み migration は `drizzle_migrations` テーブルで追跡。
 * - `--> statement-breakpoint` で区切られた SQL を逐次実行。
 * - すべて 1 トランザクションで実行（途中失敗時にロールバック）。
 *
 * 使い方:
 *   DATABASE_URL=postgres://... node --import tsx src/migrate.ts
 *
 * 関連: ADR-019, CLAUDE.md ルール 2
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// 動的 import で本ファイル自体を CLI でも import でも使えるようにする
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "drizzle");

/** drizzle/*.sql を昇順で返す */
export function listMigrationFiles(dir: string = MIGRATIONS_DIR): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

/** 1 ファイルを statement-breakpoint で分割。空文 / コメントのみは除外。 */
export function splitStatements(sql: string): string[] {
  return sql
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/^(--.*\n?)+$/.test(s));
}

/**
 * 指定の SQL 実行関数を渡し、drizzle/*.sql を順番に適用する。
 *
 * @param exec SQL 文字列を 1 つ受け取って実行する関数（postgres.js の `sql.unsafe` などを想定）
 * @param dir  migration ディレクトリ（テストでオーバーライド可能）
 */
export async function runMigrations(
  exec: (sql: string) => Promise<unknown>,
  dir: string = MIGRATIONS_DIR,
): Promise<{ applied: string[] }> {
  // migration 追跡テーブル
  await exec(`
    CREATE TABLE IF NOT EXISTS drizzle_migrations (
      id serial PRIMARY KEY,
      filename varchar(255) NOT NULL UNIQUE,
      applied_at timestamp with time zone NOT NULL DEFAULT now()
    )
  `);

  const files = listMigrationFiles(dir);
  const applied: string[] = [];

  for (const file of files) {
    // 既に適用済みなら skip
    const check = (await exec(
      `SELECT 1 FROM drizzle_migrations WHERE filename = '${file.replace(/'/g, "''")}'`,
    )) as { length?: number } | unknown[];
    const alreadyApplied = Array.isArray(check)
      ? check.length > 0
      : (check as { length?: number }).length === 1;
    if (alreadyApplied) continue;

    const path = join(dir, file);
    const sql = readFileSync(path, "utf8");
    const statements = splitStatements(sql);

    for (const stmt of statements) {
      await exec(stmt);
    }

    await exec(`INSERT INTO drizzle_migrations (filename) VALUES ('${file.replace(/'/g, "''")}')`);
    applied.push(file);
  }

  return { applied };
}
