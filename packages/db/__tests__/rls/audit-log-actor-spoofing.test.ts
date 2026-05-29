import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSql, getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * NFR04 (Repudiation) — audit_log_insert WITH CHECK で actor_user_id 詐称を防止。
 *
 * Issue #100 (PR #93 Reviewer High 5 follow-up):
 *   旧 policy は school_id チェックのみで、actor_user_id を任意の uuid に偽装した
 *   監査ログを生成できた → 法的証拠力が低下。
 *
 * Issue #105 (PR #103 Reviewer Medium 1 follow-up、migration 0005):
 *   policy を厳格化 — テナント内ロール (school_admin / teacher) は
 *   actor_user_id = NULL も拒否。system_admin のみ NULL / 任意 uuid 許可。
 *
 *   本テストは新 WITH CHECK 条件
 *     current_setting('app.current_user_role') = 'system_admin'
 *     OR actor_user_id = current_setting('app.current_user_id')::uuid
 *   が想定通り動作することを検証する (NULL 行の挙動 2 ケース追加)。
 */
describeOrSkip("audit_log: actor_user_id spoofing prevention", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const sql = createSql(url!);
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;

  beforeAll(async () => {
    fx = await seedBaseFixture(sql);
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  it("school_admin が自分自身を actor として INSERT → 成功", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
      await tx`SELECT set_config('app.current_user_role', 'school_admin', true)`;
      await tx`SELECT set_config('app.current_user_id', ${fx.userA}, true)`;

      const [row] = await tx<{ id: string }[]>`
        INSERT INTO audit_log (school_id, actor_user_id, table_name, record_id, operation, diff)
        VALUES (${fx.schoolA}, ${fx.userA}, 'contents', ${fx.schoolA}, 'insert', ${sql.json({ ok: 1 })})
        RETURNING id
      `;
      expect(row.id).toBeTruthy();
    });
  });

  it("school_admin が他ユーザーを actor に詐称した INSERT → policy で拒否", async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
        await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
        await tx`SELECT set_config('app.current_user_role', 'school_admin', true)`;
        await tx`SELECT set_config('app.current_user_id', ${fx.userA}, true)`;

        // actor を userB に詐称
        await tx`
          INSERT INTO audit_log (school_id, actor_user_id, table_name, record_id, operation, diff)
          VALUES (${fx.schoolA}, ${fx.userB}, 'contents', ${fx.schoolA}, 'insert', ${sql.json({ forged: true })})
        `;
      }),
    ).rejects.toThrow(/row-level security|new row violates/i);
  });

  it("system_admin は任意の actor_user_id で INSERT 可 (cross-tenant 正当)", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_user_role', 'system_admin', true)`;
      // current_user_id 未設定でも system_admin なので OK

      const [row] = await tx<{ id: string }[]>`
        INSERT INTO audit_log (school_id, actor_user_id, table_name, record_id, operation, diff)
        VALUES (${fx.schoolA}, ${fx.userB}, 'contents', ${fx.schoolA}, 'insert', ${sql.json({ sysadmin: true })})
        RETURNING id
      `;
      expect(row.id).toBeTruthy();
    });
  });

  it("school_admin context で actor_user_id = NULL の INSERT → policy で拒否 (Issue #105)", async () => {
    // 旧 policy では許可していたが、乗っ取られた school_admin が actor を
    // 匿名化して監査ログに自分の操作痕跡を消せる懸念 (NFR04 Repudiation) のため
    // migration 0005 で禁止。
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
        await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
        await tx`SELECT set_config('app.current_user_role', 'school_admin', true)`;
        await tx`SELECT set_config('app.current_user_id', ${fx.userA}, true)`;

        await tx`
          INSERT INTO audit_log (school_id, actor_user_id, table_name, record_id, operation, diff)
          VALUES (${fx.schoolA}, NULL, 'contents', ${fx.schoolA}, 'insert', ${sql.json({ anonymised: true })})
        `;
      }),
    ).rejects.toThrow(/row-level security|new row violates/i);
  });

  it("system_admin context で actor_user_id = NULL の INSERT → 成功 (cross-tenant 内部操作)", async () => {
    // system_admin は cross-tenant の内部集計 / migrator 経由 INSERT で
    // actor を NULL にすることがあるため、引き続き許可。
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_user_role', 'system_admin', true)`;
      // current_user_id 未設定でも system_admin なら NULL actor OK

      const [row] = await tx<{ id: string }[]>`
        INSERT INTO audit_log (school_id, actor_user_id, table_name, record_id, operation, diff)
        VALUES (${fx.schoolA}, NULL, 'contents', ${fx.schoolA}, 'insert', ${sql.json({ sysadmin_internal: true })})
        RETURNING id
      `;
      expect(row.id).toBeTruthy();
    });
  });
});
