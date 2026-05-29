import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSql, getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

describeOrSkip("RLS CRM cross-tenant (system_admin 限定アクセス)", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const sql = createSql(url!);
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;

  beforeAll(async () => {
    fx = await seedBaseFixture(sql);
    // 広告主 + 契約 + 折衝メモを直接投入 (BYPASSRLS スーパーユーザー)
    const [adv] = await sql<{ id: string }[]>`
      INSERT INTO advertisers (company_name, industry, contact_email)
      VALUES ('テスト広告主', 'IT', 'sales@example.com')
      RETURNING id
    `;
    await sql`
      INSERT INTO contracts (advertiser_id, status, started_at, monthly_fee_jpy)
      VALUES (${adv.id}, 'active', now(), 50000)
    `;
    await sql`
      INSERT INTO communications (advertiser_id, channel, occurred_at, subject)
      VALUES (${adv.id}, 'email', now(), '初回提案')
    `;
  });

  beforeEach(async () => {
    await sql`RESET ROLE`;
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  it("school_admin role + app ロール → advertisers / contracts / communications すべて 0 件", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
      await tx`SELECT set_config('app.current_user_role', 'school_admin', true)`;

      const adv = await tx`SELECT id FROM advertisers`;
      const con = await tx`SELECT id FROM contracts`;
      const com = await tx`SELECT id FROM communications`;
      expect(adv.length).toBe(0);
      expect(con.length).toBe(0);
      expect(com.length).toBe(0);
    });
  });

  it("teacher / student / guardian も CRM テーブルは見えない", async () => {
    for (const role of ["teacher", "student", "guardian"] as const) {
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
        await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
        await tx`SELECT set_config('app.current_user_role', ${role}, true)`;

        const adv = await tx`SELECT id FROM advertisers`;
        expect(adv.length, `role=${role}`).toBe(0);
      });
    }
  });

  it("school_admin が advertisers に INSERT も拒否される (WITH CHECK)", async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
        await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
        await tx`SELECT set_config('app.current_user_role', 'school_admin', true)`;
        await tx`
          INSERT INTO advertisers (company_name) VALUES ('詐称広告主')
        `;
      }),
    ).rejects.toThrow(/row-level security|new row violates/i);
  });

  it("system_admin role → advertisers / contracts / communications 全件可視", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_user_role', 'system_admin', true)`;

      const adv = await tx<{ company_name: string }[]>`SELECT company_name FROM advertisers`;
      const con = await tx<{ status: string }[]>`SELECT status FROM contracts`;
      const com = await tx<{ subject: string }[]>`SELECT subject FROM communications`;
      expect(adv.length).toBe(1);
      expect(adv[0].company_name).toBe("テスト広告主");
      expect(con.length).toBe(1);
      expect(con[0].status).toBe("active");
      expect(com.length).toBe(1);
      expect(com[0].subject).toBe("初回提案");
    });
  });

  it("system_admins / schools も同じ系統 (system_admin のみ書き込み可)", async () => {
    // school_admin による schools INSERT は拒否
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
        await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
        await tx`SELECT set_config('app.current_user_role', 'school_admin', true)`;
        await tx`INSERT INTO schools (name, prefecture) VALUES ('勝手な学校', '東京都')`;
      }),
    ).rejects.toThrow(/row-level security|new row violates/i);

    // school_admin による自校 schools SELECT は read policy で許可 (1 件)
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
      await tx`SELECT set_config('app.current_user_role', 'school_admin', true)`;
      const rows = await tx<{ id: string }[]>`SELECT id FROM schools`;
      expect(rows.length).toBe(1);
      expect(rows[0].id).toBe(fx.schoolA);
    });
  });
});
