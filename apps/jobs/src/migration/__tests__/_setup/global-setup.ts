import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectMigrationFiles, runMigrationFile } from "@kimiterrace/db/migrate-files";
import postgres from "postgres";
import { assertTestDatabase } from "./test-db.js";

/**
 * apps/jobs (トラック⑤ レーンC) 専用の vitest globalSetup。
 *
 * 合成移行 dry-run ([import-dry-run.test.ts](../import-dry-run.test.ts)) が実 PG の実構成
 * (RLS / 監査トリガ / hash chain / scope CHECK) に対して突合できるよう、test DB を初期化する。
 *
 * ## なぜ packages/db の globalSetup を共有しないか (衝突回避)
 * test-strategy §6.1 は共有 `packages/db/__tests__/_setup/global-setup.ts` を **schema-token
 * chokepoint** と定義し「各トラックが各自拡張すると loader/RLS 真実ソースを奪い合う」と警告する。
 * よって apps/jobs は共有ファイルに触れず**自前で**スキーマを初期化する (適用順の単一ソースである
 * `@kimiterrace/db/migrate-files` の `collectMigrationFiles` は共有 = drift しない)。
 *
 * ## クラスタ大域 role の作成レース回避 (直列化)
 * `migrations/0002_rls_policies.sql` は `kimiterrace_app` 等を `CREATE ROLE IF NOT EXISTS` で作る。
 * role はクラスタ大域なので、`turbo run test` が apps/jobs と packages/db のマイグレーションを
 * **同時**に流すと「IF NOT EXISTS → CREATE」の間で衝突し duplicate_object で flaky になる。
 * これを避けるため [apps/jobs/turbo.json](../../../../turbo.json) で `test` を `@kimiterrace/db#test`
 * の後段に直列化する (本 setup 自体は self-sufficient で、単独 `pnpm --filter @kimiterrace/jobs test`
 * でも DROP→migrate でスキーマを用意する)。
 *
 * ## DATABASE_URL 未設定時
 * 実 PG が無い環境ではスキーマ初期化をスキップ → 各 test は `getConnectionUrl()` null で describe.skip。
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
// apps/jobs/src/migration/__tests__/_setup → リポジトリルートの packages/db (6 階層上)。
const dbPackageRoot = join(__dirname, "..", "..", "..", "..", "..", "..", "packages", "db");

export async function setup(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.warn(
      "[jobs-mig-tests] DATABASE_URL 未設定のため実 PG dry-run をスキップします。" +
        " docker compose up -d postgres + DATABASE_URL 設定で有効化されます。",
    );
    return;
  }

  // prod / staging DB 誤接続防止 (DROP SCHEMA CASCADE の footgun を止める)。
  assertTestDatabase(url);

  // DDL は単一接続で順に流す (packages/db globalSetup と同じ max:1。pool 経路の曖昧さを排除)。
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    // 1) クリーンスレート (test DB 限定の前提 — assertTestDatabase で保証済)。
    await sql.unsafe("DROP SCHEMA IF EXISTS public CASCADE;");
    await sql.unsafe("CREATE SCHEMA public;");
    await sql.unsafe("GRANT ALL ON SCHEMA public TO public;");

    // 2) 拡張 (pgvector + pgcrypto)。
    await sql.unsafe("CREATE EXTENSION IF NOT EXISTS vector;");
    await sql.unsafe("CREATE EXTENSION IF NOT EXISTS pgcrypto;");

    // 3) マイグレーションを適用順 (drizzle DDL → 手書き RLS/トリガ/VIEW/関数) で流す。
    //    適用順の真実ソースは @kimiterrace/db/migrate-files の collectMigrationFiles (RLS スイートと共有)。
    for (const file of collectMigrationFiles(dbPackageRoot)) {
      await runMigrationFile(sql, file);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export async function teardown(): Promise<void> {
  // test DB の中身は次回 setup で破棄されるため何もしない。
}
