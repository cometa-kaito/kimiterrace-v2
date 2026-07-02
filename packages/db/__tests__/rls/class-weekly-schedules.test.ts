import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDbClient } from "../../src/client.js";
import { getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * 週次ベース時間割（F5）class_weekly_schedules の RLS テナント分離を実 PG で検証する（0036_class_weekly_schedules_rls）。
 *
 * - tenant_isolation: 自校のみ可視 / 別テナントは 0 件 / context 未設定は deny-by-default
 * - WITH CHECK: 別テナント school_id への INSERT は拒否（cross-tenant 書込防止・ルール2）
 * 実 PG（DATABASE_URL）でのみ走り未設定ならスキップ（ADR-012）。read は kimiterrace_app へ降格し RLS を実際に効かせる。
 */
describeOrSkip("RLS: class_weekly_schedules（週次ベース時間割）", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const { sql: raw } = createDbClient(url!);
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;
  let classA: string;
  let classB: string;

  async function seedClass(schoolId: string, name: string): Promise<string> {
    const [row] = await raw<{ id: string }[]>`
      INSERT INTO classes (school_id, name, grade)
      VALUES (${schoolId}, ${name}, 1) RETURNING id`;
    return row.id;
  }

  /** テンプレ 1 行を owner（superuser）で直挿し（RLS はテスト seed をバイパス）。 */
  async function seedTimetable(schoolId: string, classId: string): Promise<void> {
    await raw`
      INSERT INTO class_weekly_schedules (school_id, class_id, schedule_by_weekday)
      VALUES (${schoolId}, ${classId}, ${'{"1":[{"period":1,"subject":"数学"}]}'}::jsonb)`;
  }

  /** kimiterrace_app へ降格し school/role context 下で対象クラスのテンプレ id を引く。 */
  async function selectAs(
    schoolId: string | null,
    role: string | null,
    classId: string,
  ): Promise<{ id: string }[]> {
    return await raw.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      if (schoolId) {
        await tx`SELECT set_config('app.current_school_id', ${schoolId}, true)`;
      }
      if (role) {
        await tx`SELECT set_config('app.current_user_role', ${role}, true)`;
      }
      return await tx<{ id: string }[]>`
        SELECT id FROM class_weekly_schedules WHERE class_id = ${classId}`;
    });
  }

  beforeAll(async () => {
    fx = await seedBaseFixture(raw);
    classA = await seedClass(fx.schoolA, "1-A");
    classB = await seedClass(fx.schoolB, "1-B");
  });

  beforeEach(async () => {
    await raw`RESET ROLE`;
    await raw`DELETE FROM class_weekly_schedules`;
  });

  afterAll(async () => {
    await raw.end({ timeout: 5 });
  });

  it("テナント分離: A コンテキストからは A のテンプレのみ / B は不可視、B からは B のみ", async () => {
    await seedTimetable(fx.schoolA, classA);
    await seedTimetable(fx.schoolB, classB);

    expect(await selectAs(fx.schoolA, "school_admin", classA)).toHaveLength(1);
    expect(await selectAs(fx.schoolA, "school_admin", classB)).toHaveLength(0); // 別校は RLS で 0
    expect(await selectAs(fx.schoolB, "school_admin", classB)).toHaveLength(1);
  });

  it("空コンテキストは deny-by-default で 0 件", async () => {
    await seedTimetable(fx.schoolA, classA);
    expect(await selectAs(null, null, classA)).toHaveLength(0);
  });

  it("別テナント school_id への INSERT は WITH CHECK で拒否（cross-tenant 書込防止）", async () => {
    await expect(
      raw.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
        await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
        await tx`SELECT set_config('app.current_user_role', 'school_admin', true)`;
        // A コンテキストで B 校のテンプレを入れようとする → tenant_isolation WITH CHECK 違反。
        await tx`
          INSERT INTO class_weekly_schedules (school_id, class_id, schedule_by_weekday)
          VALUES (${fx.schoolB}, ${classB}, '{}'::jsonb)`;
      }),
    ).rejects.toThrow();
  });
});
