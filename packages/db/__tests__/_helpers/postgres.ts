/**
 * Testcontainers postgres への接続ヘルパ。
 *
 * - 実体は `__tests__/_helpers/global-setup.ts` がプロセス起動時に 1 度だけ起動・migration 完了。
 * - 接続情報は `process.env.TEST_PG_URL` に注入される。
 * - 各テストファイル内では本ヘルパで `admin` / `app` の接続を取得し、
 *   afterAll で接続のみクローズ（コンテナは globalSetup の teardown で停止）。
 *
 * RLS は session role が BYPASSRLS を持つと無効化される。テスト DB の所有者は
 * `postgres` (superuser, BYPASSRLS 同等) なので、アプリ接続では明示的に
 * `SET LOCAL ROLE app_user` してから検証する。
 *
 * 関連: ADR-012, ADR-019
 */
import postgres from "postgres";

let admin: postgres.Sql | null = null;
let app: postgres.Sql | null = null;

function getUri(): string {
  const uri = process.env.TEST_PG_URL;
  if (!uri) {
    throw new Error("TEST_PG_URL is not set. Did __tests__/_helpers/global-setup.ts run?");
  }
  return uri;
}

export function getAdmin(): postgres.Sql {
  if (!admin) {
    admin = postgres(getUri(), { max: 4, onnotice: () => undefined });
  }
  return admin;
}

export function getApp(): postgres.Sql {
  if (!app) {
    app = postgres(getUri(), { max: 4, onnotice: () => undefined });
  }
  return app;
}

export interface TestPg {
  admin: postgres.Sql;
  app: postgres.Sql;
  cleanup: () => Promise<void>;
}

/**
 * 旧 API 互換 (テストコード側で `const pg = await getSharedPg();` できるよう、
 * admin/app の lazy 接続をまとめて返す。cleanup は接続のみクローズ)。
 */
export async function getSharedPg(): Promise<TestPg> {
  return {
    admin: getAdmin(),
    app: getApp(),
    cleanup: async () => {
      // no-op: 接続は process exit までキープ。コンテナは globalSetup の teardown で止まる。
    },
  };
}

/**
 * 全 RLS 対象テーブルを TRUNCATE してテスト間で状態を分離する。
 *
 * audit_log は append-only trigger により superuser でも DELETE 不可。
 * TRUNCATE は DML ではなく DDL 扱いで trigger を回避できるため、唯一の clear 手段。
 */
export async function resetData(pg: TestPg): Promise<void> {
  await pg.admin.unsafe(`
    TRUNCATE TABLE
      "audit_log",
      "monthly_reports",
      "ai_chat_messages", "ai_chat_sessions", "ai_extractions",
      "events", "publishes", "content_versions", "contents",
      "magic_links", "memberships", "classes", "users", "schools",
      "communications", "contracts", "advertisers", "system_admins"
    RESTART IDENTITY CASCADE
  `);
}

/**
 * `app` 接続をテナント context 付きで使う。RLS が効くよう role を切り替える。
 *
 * 使い方:
 * ```ts
 * await withTenant(pg, { schoolId, role: "teacher" }, async (sql) => {
 *   const rows = await sql`SELECT * FROM users`;
 * });
 * ```
 */
export async function withTenant<T>(
  pg: TestPg,
  ctx: { schoolId?: string; role?: string; userId?: string },
  fn: (sql: postgres.Sql) => Promise<T>,
): Promise<T> {
  return await pg.app.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE app_user");
    if (ctx.schoolId !== undefined) {
      // SET LOCAL は parameter binding 不可なので literal にする (UUID なので safe)
      await tx.unsafe(`SET LOCAL app.current_school_id = '${ctx.schoolId}'`);
    }
    if (ctx.role !== undefined) {
      await tx.unsafe(`SET LOCAL app.current_user_role = '${ctx.role}'`);
    }
    if (ctx.userId !== undefined) {
      await tx.unsafe(`SET LOCAL app.current_user_id = '${ctx.userId}'`);
    }
    return await fn(tx);
  });
}
