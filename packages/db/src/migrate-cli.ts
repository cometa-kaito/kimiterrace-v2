import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { applyMigrations } from "./migrate-runner.js";

/**
 * 本番 migration runner の実行可能エントリ。Cloud Run Job が `node dist/migrate-cli.js`
 * (= `CMD ["node","dist/migrate-cli.js"]`) で起動する。
 *
 * 必須 env:
 *   - `DATABASE_URL`                     migrator (cloudsqlsuperuser) 接続文字列。Secret Manager 経由 (ルール5)。
 * 任意 env:
 *   - `MIGRATE_GRANT_APP_ROLE_MEMBER`    設定すると全 migration 後に `GRANT kimiterrace_app TO <値>`。
 *                                        staging では app login user `app` を渡す。
 *
 * ★ ログにもエラーにも DATABASE_URL / パスワードを出さない (ルール5)。
 */

/**
 * drizzle/ と migrations/ を含むパッケージルートを解決する。
 *
 * ビルド後の配置は `<packageRoot>/dist/migrate-cli.js` なので、`import.meta.url` から
 * 2 階層上がパッケージルート。コンテナ runtime (WORKDIR=/app/packages/db) でも
 * ローカル (`node dist/migrate-cli.js`) でもこの相対関係は同じ。
 *
 * 念のため `drizzle/` の実在を確認し、無ければ `process.cwd()` を試し、それでも
 * 見つからなければ明示エラーで exit 1 (誤った場所から空適用するより fail-fast)。
 */
function resolvePackageRoot(): string {
  const fromDist = dirname(dirname(fileURLToPath(import.meta.url)));
  if (existsSync(join(fromDist, "drizzle"))) {
    return fromDist;
  }
  const cwd = process.cwd();
  if (existsSync(join(cwd, "drizzle"))) {
    return cwd;
  }
  console.error(
    `migrate-cli: drizzle/ が見つかりません (探索: ${fromDist}, ${cwd})。` +
      " パッケージルート (drizzle/ と migrations/ を含むディレクトリ) から実行してください。",
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL required");
    process.exit(1);
  }

  const packageRoot = resolvePackageRoot();

  // migrator は DDL / CREATE EXTENSION / GRANT を流すため特権ロールで単一接続。
  // onnotice を握りつぶし、NOTICE が secret を含むログに混ざらないようにする。
  const sql = postgres(url, { max: 1, onnotice: () => {} });

  let exitCode = 0;
  try {
    await applyMigrations(sql, packageRoot, {
      grantAppRoleMember: process.env.MIGRATE_GRANT_APP_ROLE_MEMBER || undefined,
    });
    console.log("migration complete");
  } catch (err) {
    // ★ url は出さない。err は postgres driver の例外で、接続失敗時も DSN 全文は含まない。
    console.error(err);
    exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
  process.exit(exitCode);
}

void main();
