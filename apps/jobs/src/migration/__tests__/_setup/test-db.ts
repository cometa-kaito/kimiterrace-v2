/**
 * トラック⑤ レーンC: apps/jobs 合成移行 dry-run の実 PG 接続ユーティリティ。
 *
 * 設計 (docs/testing/tracks/05-migration-audit-compliance.md §5 / test-strategy §6.1):
 * - **共有シードを汚さない**: packages/db の RLS スイートが使う共有
 *   `packages/db/__tests__/_setup/global-setup.ts` (= schema-token chokepoint) には触れず、
 *   apps/jobs は**自前の vitest globalSetup** ([global-setup.ts](./global-setup.ts)) で
 *   同一 test DB のスキーマを初期化する。§6.1 が認める「トラックごとに使い捨て DB を分けて並列」の
 *   apps/jobs ローカル版 (`turbo.json` で db#test の後段に直列化し、クラスタ大域 role 作成レースを回避)。
 * - **DATABASE_URL 未設定なら skip**: 各 test ファイルは `getConnectionUrl()` が null なら describe.skip。
 *   (ADR-012 = 実 PG は DATABASE_URL env。無い環境ではユニット相当に縮退。)
 */

/**
 * 実 PG dry-run を走らせる接続 URL を返す。無効化フラグ or DATABASE_URL 未設定なら null。
 *
 * `JOBS_PG_TESTS_SKIP=1` は明示 opt-out 用 (packages/db の `RLS_TESTS_SKIP` と独立。
 * apps/jobs だけ skip したいケースで使う)。
 */
export function getConnectionUrl(): string | null {
  if (process.env.JOBS_PG_TESTS_SKIP === "1") return null;
  return process.env.DATABASE_URL ?? null;
}

/**
 * `DATABASE_URL` を test-DB として安全に使えるか検証する (H1 ガード、packages/db と同思想)。
 *
 * globalSetup は `DROP SCHEMA public CASCADE` を流すため、prod / staging DB に誤接続すると
 * 1 サイクルで学校データが消える footgun。以下のいずれも満たさない場合は throw して
 * setup を失敗させ、全テストを abort する (= 破壊を未然に止める):
 *   1. `KIMITERRACE_TEST_DB_OK=1` が明示設定 (CI で正攻法)
 *   2. ホストが localhost / 127.0.0.1 / ::1 / host.docker.internal (ローカル PG)
 *   3. DB 名が "test" を含む (パターン)
 */
export function assertTestDatabase(url: string): void {
  if (process.env.KIMITERRACE_TEST_DB_OK === "1") return;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      "[jobs-mig-tests] DATABASE_URL を URL として解釈できません。実 PG dry-run には " +
        "`postgresql://...` 形式が必要です。",
    );
  }

  const host = parsed.hostname.toLowerCase();
  const localHosts = new Set(["localhost", "127.0.0.1", "::1", "host.docker.internal"]);
  if (localHosts.has(host)) return;

  const dbName = parsed.pathname.replace(/^\//, "").toLowerCase();
  if (/test/.test(dbName)) return;

  throw new Error(
    `[jobs-mig-tests] DATABASE_URL が test-DB と判定できません (host=${host}, db=${dbName})。 ` +
      "DROP SCHEMA CASCADE を拒否しました。 (a) DB 名に 'test' を含める / (b) ホストを localhost 系にする / " +
      "(c) KIMITERRACE_TEST_DB_OK=1 を設定する、のいずれかを行ってください。",
  );
}
