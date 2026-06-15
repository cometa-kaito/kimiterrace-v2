import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSql, getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * ルール2: テナント分離テーブルには「許可ケース + 拒否ケース両方」の RLS テストを置く。
 *
 * `memberships`（ユーザー × クラス × 学校の所属 junction = 「誰がどの学校のどのクラスに
 * 属すか」）はテナント分離の根幹だが、専用の cross-tenant 拒否テストが存在しなかった
 * （`audit-columns.test.ts` が監査カラムを触るのみ、`tenant-isolation.test.ts` は
 * contents/users/schools のみ実検証）。本ファイルでその穴を塞ぐ（Refs #266 / #59）。
 *
 * memberships の RLS policy（migration 0002 系）:
 * - `tenant_isolation` (FOR ALL): USING/WITH CHECK = school_id = app.current_school_id
 * - `system_admin_full_access` (FOR ALL): USING/WITH CHECK = app.current_user_role = 'system_admin'
 * いずれも PERMISSIVE のため OR 合成される（contents/schools と同形）。
 */
describeOrSkip("RLS: memberships テナント分離 (#266)", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const sql = createSql(url!);
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;
  let classA: string;
  let classB: string;
  let userA2: string;

  beforeAll(async () => {
    fx = await seedBaseFixture(sql);

    // 各校にクラスを 1 件ずつ（BYPASSRLS = テーブル所有者接続で投入）
    const [cA] = await sql<{ id: string }[]>`
      INSERT INTO classes (school_id, name, grade)
      VALUES (${fx.schoolA}, '1-A', 1)
      RETURNING id
    `;
    classA = cA.id;
    const [cB] = await sql<{ id: string }[]>`
      INSERT INTO classes (school_id, name, grade)
      VALUES (${fx.schoolB}, '1-B', 1)
      RETURNING id
    `;
    classB = cB.id;

    // school A の 2 人目ユーザー（許可 INSERT / 詐称 INSERT で一意制約 (class_id,user_id) と
    // 衝突しない新規 (class,user) ペアを作るために用意）
    const [uA2] = await sql<{ id: string }[]>`
      INSERT INTO users (school_id, identity_uid, role, display_name)
      VALUES (${fx.schoolA}, 'uid-A2', 'teacher', '担任 A2')
      RETURNING id
    `;
    userA2 = uA2.id;

    // 各校に所属を 1 件ずつ
    await sql`
      INSERT INTO memberships (school_id, class_id, user_id, membership_role)
      VALUES (${fx.schoolA}, ${classA}, ${fx.userA}, 'homeroom_teacher')
    `;
    await sql`
      INSERT INTO memberships (school_id, class_id, user_id, membership_role)
      VALUES (${fx.schoolB}, ${classB}, ${fx.userB}, 'homeroom_teacher')
    `;
  });

  beforeEach(async () => {
    // 直前 tx の SET LOCAL は次 tx に残らないが、念のため RESET ROLE でクリーンに。
    await sql`RESET ROLE`;
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  it("school A context (school_admin) → A の所属のみ可視", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
      await tx`SELECT set_config('app.current_user_role', 'school_admin', true)`;

      const rows = await tx<{ school_id: string; user_id: string }[]>`
        SELECT school_id, user_id FROM memberships
      `;
      expect(rows.length).toBe(1);
      expect(rows[0].school_id).toBe(fx.schoolA);
      expect(rows[0].user_id).toBe(fx.userA);
    });
  });

  it("school B context → B の所属のみ可視 (別テナントは見えない)", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_school_id', ${fx.schoolB}, true)`;
      await tx`SELECT set_config('app.current_user_role', 'school_admin', true)`;

      const rows = await tx<{ school_id: string }[]>`SELECT school_id FROM memberships`;
      expect(rows.length).toBe(1);
      expect(rows[0].school_id).toBe(fx.schoolB);
    });
  });

  it("context 未設定 → 全件拒否 (0 件、deny by default)", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      const rows = await tx<{ id: string }[]>`SELECT id FROM memberships`;
      expect(rows.length).toBe(0);
    });
  });

  it("context=A で school_id=B の所属を INSERT → WITH CHECK で拒否", async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
        await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
        await tx`SELECT set_config('app.current_user_role', 'school_admin', true)`;
        // (classB, userA2) は一意制約に未使用・FK 充足。school_id=B が WITH CHECK で弾かれる
        // ことを示す（FK / unique 違反ではなく RLS 違反であることが要点）。
        await tx`
          INSERT INTO memberships (school_id, class_id, user_id, membership_role)
          VALUES (${fx.schoolB}, ${classB}, ${userA2}, 'student')
        `;
      }),
    ).rejects.toThrow(/row-level security|new row violates/i);
  });

  it("context=A で B の所属を UPDATE → 0 行 (USING で不可視)、実値も不変", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
      await tx`SELECT set_config('app.current_user_role', 'school_admin', true)`;

      const res = await tx`
        UPDATE memberships SET membership_role = 'sub_teacher' WHERE school_id = ${fx.schoolB}
      `;
      expect(res.count).toBe(0);
    });

    // B の所属が改竄されていないことを BYPASSRLS 接続で確認
    const after = await sql<{ membership_role: string }[]>`
      SELECT membership_role FROM memberships WHERE school_id = ${fx.schoolB}
    `;
    expect(after.length).toBe(1);
    expect(after[0].membership_role).toBe("homeroom_teacher");
  });

  it("context=A で B の所属を DELETE → 0 行 (USING で不可視)、行は残存", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
      await tx`SELECT set_config('app.current_user_role', 'school_admin', true)`;

      const res = await tx`DELETE FROM memberships WHERE school_id = ${fx.schoolB}`;
      expect(res.count).toBe(0);
    });

    const after = await sql<{ id: string }[]>`
      SELECT id FROM memberships WHERE school_id = ${fx.schoolB}
    `;
    expect(after.length).toBe(1);
  });

  it("system_admin → cross-tenant で全校の所属が見える", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_user_role', 'system_admin', true)`;
      // school_id 未設定でも system_admin は全件可視

      const rows = await tx<{ school_id: string }[]>`
        SELECT school_id FROM memberships ORDER BY school_id
      `;
      expect(rows.length).toBe(2);
      expect(new Set(rows.map((r) => r.school_id))).toEqual(new Set([fx.schoolA, fx.schoolB]));
    });
  });

  // 許可ケース（最後に置く: コミットして A の所属が +1 されるため、件数を前提にする他テストより後）。
  it("context=A で school_id=A の所属を INSERT → 許可 (WITH CHECK 通過)", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
      await tx`SELECT set_config('app.current_user_role', 'school_admin', true)`;

      await tx`
        INSERT INTO memberships (school_id, class_id, user_id, membership_role)
        VALUES (${fx.schoolA}, ${classA}, ${userA2}, 'student')
      `;
      const rows = await tx<{ id: string }[]>`SELECT id FROM memberships`;
      expect(rows.length).toBe(2);
    });
  });
});
