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
 *   本テストは追加された WITH CHECK 条件
 *     actor_user_id IS NULL
 *     OR actor_user_id = current_setting('app.current_user_id')::uuid
 *     OR current_setting('app.current_user_role') = 'system_admin'
 *   が想定通り動作することを検証する。
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

  it("actor_user_id = NULL は許可 (内部システム操作 / cross-tenant のため)", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
      await tx`SELECT set_config('app.current_user_role', 'school_admin', true)`;
      await tx`SELECT set_config('app.current_user_id', ${fx.userA}, true)`;

      const [row] = await tx<{ id: string }[]>`
        INSERT INTO audit_log (school_id, actor_user_id, table_name, record_id, operation, diff)
        VALUES (${fx.schoolA}, NULL, 'contents', ${fx.schoolA}, 'insert', ${sql.json({ system: true })})
        RETURNING id
      `;
      expect(row.id).toBeTruthy();
    });
  });
});
