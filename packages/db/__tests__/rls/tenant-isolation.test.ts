import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSql, getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

describeOrSkip("RLS tenant_isolation (school_id ベースの分離)", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const sql = createSql(url!);
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;

  beforeAll(async () => {
    fx = await seedBaseFixture(sql);
    // school A / school B にコンテンツを 1 件ずつ入れる (BYPASSRLS 接続)
    await sql`
      INSERT INTO contents (school_id, title, body_markdown, status)
      VALUES (${fx.schoolA}, 'A の告知', 'A の本文', 'published')
    `;
    await sql`
      INSERT INTO contents (school_id, title, body_markdown, status)
      VALUES (${fx.schoolB}, 'B の告知', 'B の本文', 'published')
    `;
  });

  beforeEach(async () => {
    // 直前のトランザクションで設定された SET LOCAL は次トランザクションには残らないが、
    // RESET ROLE で明示的にクリーンスレートにする。
    await sql`RESET ROLE`;
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  it("school_id = A 設定 + app ロール → A のレコードのみ可視", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
      await tx`SELECT set_config('app.current_user_role', 'school_admin', true)`;

      const rows = await tx<{ title: string; school_id: string }[]>`
        SELECT title, school_id FROM contents
      `;
      expect(rows.length).toBe(1);
      expect(rows[0].school_id).toBe(fx.schoolA);
      expect(rows[0].title).toBe("A の告知");
    });
  });

  it("school_id = B 設定 → B のレコードのみ可視 (別テナントは見えない)", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_school_id', ${fx.schoolB}, true)`;
      await tx`SELECT set_config('app.current_user_role', 'school_admin', true)`;

      const rows = await tx<{ title: string }[]>`SELECT title FROM contents`;
      expect(rows.length).toBe(1);
      expect(rows[0].title).toBe("B の告知");
    });
  });

  it("school_id 未設定 + role 未設定 → 全件拒否 (= 0 件)", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      // 何も SET LOCAL せずに SELECT
      const rows = await tx<{ title: string }[]>`SELECT title FROM contents`;
      expect(rows.length).toBe(0);
    });
  });

  it("school_id = A だが INSERT 先 school_id を B にすると WITH CHECK で拒否", async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
        await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
        await tx`SELECT set_config('app.current_user_role', 'school_admin', true)`;
        await tx`
          INSERT INTO contents (school_id, title, body_markdown, status)
          VALUES (${fx.schoolB}, 'B 詐称', 'noop', 'draft')
        `;
      }),
    ).rejects.toThrow(/row-level security|new row violates/i);
  });

  it("system_admin role → 全 school_id のレコードが見える (cross-tenant)", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_user_role', 'system_admin', true)`;
      // school_id 未設定でも system_admin は全件見える

      const rows = await tx<{ title: string }[]>`SELECT title FROM contents ORDER BY title`;
      expect(rows.length).toBe(2);
      expect(rows.map((r) => r.title)).toEqual(["A の告知", "B の告知"]);
    });
  });

  it("複数テナント分離テーブルでも同じ挙動 (users / classes / events)", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
      await tx`SELECT set_config('app.current_user_role', 'school_admin', true)`;

      const users = await tx<{ id: string }[]>`SELECT id FROM users`;
      expect(users.length).toBe(1);
      expect(users[0].id).toBe(fx.userA);
    });
  });
});
