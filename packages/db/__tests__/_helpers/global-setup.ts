/**
 * Vitest global setup。
 *
 * 接続先 PostgreSQL の決定優先順位:
 *   1. `TEST_PG_URL` 環境変数が既に設定済 → そのまま使う (CI の services postgres / 開発機の docker-compose)
 *   2. それ以外 → Testcontainers で pgvector/pgvector:pg16 を 1 度だけ起動
 *
 * いずれの場合も `drizzle/*.sql` を順に流して migration を完了させる。
 *
 * 関連: ADR-012
 */
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import postgres from "postgres";
import { runMigrations } from "../../src/migrate.js";

let container: StartedPostgreSqlContainer | null = null;

export async function setup(): Promise<void> {
  let uri: string;

  if (process.env.TEST_PG_URL && process.env.TEST_PG_URL.length > 0) {
    // 外部 (CI services / docker-compose) で立っている DB を使う
    uri = process.env.TEST_PG_URL;
  } else {
    // ローカル開発: Testcontainers で起動
    container = await new PostgreSqlContainer("pgvector/pgvector:pg16")
      .withDatabase("kimiterrace_test")
      .withUsername("postgres")
      .withPassword("postgres")
      .start();
    uri = container.getConnectionUri();
    process.env.TEST_PG_URL = uri;
  }

  // migration を 1 度だけ流す
  const admin = postgres(uri, { max: 2, onnotice: () => undefined });
  try {
    await runMigrations(async (sql) => await admin.unsafe(sql));
  } finally {
    await admin.end({ timeout: 5 });
  }
}

export async function teardown(): Promise<void> {
  if (container) {
    await container.stop();
    container = null;
  }
}
