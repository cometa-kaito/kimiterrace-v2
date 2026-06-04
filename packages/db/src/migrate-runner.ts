import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { collectMigrationFiles, runMigrationFile } from "./migrate-files.js";

/**
 * 本番 (Cloud Run Job) でマイグレーションを冪等・resumable に適用する runner。
 *
 * vitest の RLS テスト用 globalSetup (`__tests__/_setup/global-setup.ts`) は test DB を
 * `DROP SCHEMA public CASCADE` で毎回まっさらにしてから全 SQL を流すが、本番ではそれは
 * できない (1 サイクルで学校データが消える footgun)。そこで本番は:
 *
 *   1. 適用済みファイル名を `_schema_migrations(filename pk)` で追跡し、未適用分のみ流す。
 *      baseline (`drizzle/0000_initial_baseline.sql`) は plain `CREATE TYPE`/`CREATE TABLE`
 *      で非冪等 (再実行で "already exists" エラー) ゆえ、「どこまで適用したか」を DB 側に
 *      記録しないと retry/resume できない。
 *   2. 各ファイルはトランザクションで包み、**SQL の適用と `_schema_migrations` への記録を
 *      原子的に**行う。途中で落ちて Job が再実行されても、commit 済みファイルは skip され、
 *      未 commit のファイルから再開される (= resume on retry)。
 *
 * 適用順の単一ソースは `collectMigrationFiles` (drizzle/ DDL → migrations/ 手書き RLS/
 * トリガ/VIEW/関数、各群ファイル名昇順)。SQL の文分割は `runMigrationFile` に委譲する
 * (`--> statement-breakpoint` と `$$`-aware な `;` 分割)。ここでは parser を再実装しない。
 */

/**
 * tagged-template 呼び出しを表す型。`postgres` の `sql` / トランザクション `tx` は
 * `sql\`...\`` (テンプレートリテラル) として呼べる。ここでは `_schema_migrations` への
 * INSERT を bind パラメータ付きで安全に発行するためだけに使う。
 */
type TaggedTemplate = (
  strings: TemplateStringsArray,
  ...values: readonly unknown[]
) => PromiseLike<unknown>;

/**
 * runner が必要とするトランザクション client。
 * - `runMigrationFile` が叩く `.unsafe(query)`
 * - `_schema_migrations` への INSERT を出す tagged-template 呼び出し
 */
export type MigrationTx = TaggedTemplate & {
  unsafe(query: string): PromiseLike<unknown>;
};

/**
 * runner が必要とする最小の postgres-js client。
 *
 * `postgres(url)` が返す client はこれを (より広い型として) 満たす。`postgres` の完全な
 * 型を import せず最小 interface に絞ることで、この module 自体は driver 非依存に保つ
 * (`migrate-files.ts` の方針と同じ)。
 */
export type MigrationSqlClient = TaggedTemplate & {
  unsafe(query: string): PromiseLike<unknown>;
  begin<T>(cb: (tx: MigrationTx) => Promise<T>): Promise<T>;
};

export interface ApplyMigrationsOptions {
  /**
   * 設定された場合、全 migration 適用後に `GRANT kimiterrace_app TO <member>` を実行する
   * (冪等)。staging/本番では app は `app` login で接続し `SET LOCAL ROLE kimiterrace_app`
   * (client.ts) でアプリ視点に切り替えるため、`app` を `kimiterrace_app` group role の
   * メンバーにする必要がある。`kimiterrace_app` ロール自体は migration SQL が作る前提
   * (この runner は作らない)。
   *
   * `member` はロール識別子としてバインドパラメータにできないため、SQL に文字列連結する。
   * インジェクション防止のため `SAFE_ROLE_NAME` (client.ts と同じ正規表現) で検証し、
   * 不正なら throw する。
   */
  grantAppRoleMember?: string;
  /** ログ出力先 (既定 `console.log`)。**DATABASE_URL / パスワードは絶対に渡さない**。 */
  log?: (msg: string) => void;
}

// ロール名はバインドパラメータにできないので識別子として安全な文字のみ許可する
// (client.ts の SAFE_ROLE_NAME と同一)。
const SAFE_ROLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * `_schema_migrations` の追跡キー。OS 非依存 (win32 で開発しても Linux コンテナで実行する)
 * になるよう、パス区切りを常に "/" に正規化する。
 */
function migrationKey(root: string, file: string): string {
  return relative(root, file).replaceAll("\\", "/");
}

/**
 * `root` (= `@kimiterrace/db` パッケージルート、drizzle/ と migrations/ を含む) 配下の
 * 全マイグレーションを、未適用分だけ冪等に適用する。
 *
 * @param sql  postgres-js client (`.unsafe` / `.begin` / tagged-template を持つ)。RLS を
 *             バイパスできる migrator (cloudsqlsuperuser) で接続したもの。`CREATE EXTENSION`
 *             や DDL を流すため特権が要る。
 * @param root drizzle/ と migrations/ を含むパッケージルート。
 * @param opts 任意オプション (後処理 GRANT / ログ出力先)。
 */
export async function applyMigrations(
  sql: MigrationSqlClient,
  root: string,
  opts: ApplyMigrationsOptions = {},
): Promise<void> {
  // 既定は stdout への進捗ログ (Cloud Run Job のログに残す)。呼出側が log を渡せば差し替え可。
  // biome-ignore lint/suspicious/noConsole: migration runner の既定進捗出力 (ops バッチ)。
  const log = opts.log ?? console.log;

  // Step 1: 拡張を先に作る (baseline が vector(768) / gen_random_uuid() を使うので loop より前)。
  // IF NOT EXISTS なので再実行しても安全。
  await sql.unsafe("CREATE EXTENSION IF NOT EXISTS vector;");
  await sql.unsafe("CREATE EXTENSION IF NOT EXISTS pgcrypto;");

  // Step 2: 適用済み追跡テーブル (冪等)。
  await sql.unsafe(
    "CREATE TABLE IF NOT EXISTS _schema_migrations (" +
      "filename text PRIMARY KEY, " +
      "applied_at timestamptz NOT NULL DEFAULT now())",
  );

  // Step 3: 既適用ファイル名を Set に読み込む。
  const appliedRows = (await sql.unsafe("SELECT filename FROM _schema_migrations")) as Array<{
    filename: string;
  }>;
  const applied = new Set(appliedRows.map((r) => r.filename));

  // Step 4: 適用順 (collectMigrationFiles) で未適用分のみ流す。
  for (const file of collectMigrationFiles(root)) {
    const key = migrationKey(root, file);
    if (applied.has(key)) {
      log(`skip ${key}`);
      continue;
    }

    if (readFileSync(file, "utf-8").includes("CONCURRENTLY")) {
      // CONCURRENTLY (例: CREATE INDEX CONCURRENTLY) はトランザクション内で実行できないため、
      // tx で包まずに流してから別途記録する。tx を張らない分この種のファイルだけは
      // 「SQL 適用済み・記録未済」の窓が理論上ありうるが、その retry は CONCURRENTLY を
      // IF NOT EXISTS 付きで書く前提で安全に再実行できる。
      await runMigrationFile(sql, file);
      await sql`INSERT INTO _schema_migrations (filename) VALUES (${key})`;
    } else {
      // 通常: SQL 適用と記録を 1 トランザクションで原子化 (resume on retry の要)。
      await sql.begin(async (tx) => {
        await runMigrationFile(tx, file);
        await tx`INSERT INTO _schema_migrations (filename) VALUES (${key})`;
      });
    }
    log(`applied ${key}`);
  }

  // Step 5 (任意): app login user を kimiterrace_app group role のメンバーにする。
  const member = opts.grantAppRoleMember;
  if (member !== undefined) {
    if (!SAFE_ROLE_NAME.test(member)) {
      throw new Error(`applyMigrations: 不正な grantAppRoleMember 名: ${JSON.stringify(member)}`);
    }
    // GRANT role TO role は冪等 (既メンバーでもエラーにならない)。
    await sql.unsafe(`GRANT kimiterrace_app TO ${member}`);
    log(`granted kimiterrace_app to ${member}`);
  }
}
