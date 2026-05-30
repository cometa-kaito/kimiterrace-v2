import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSql, getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * #48-A: V1 移植で追加した階層基盤テーブル (grades / departments / school_configs /
 * daily_data / ads) の RLS テナント分離 + 整合性制約を検証する。
 *
 * - tenant_isolation: 自校のみ可視、他テナント INSERT は WITH CHECK で拒否
 * - system_admin_full_access: cross-tenant で全件可視
 * - CHECK 制約 (scope ↔ *_id 整合性)
 * - UNIQUE NULLS NOT DISTINCT (school スコープの全 *_id NULL でも重複拒否)
 */
describeOrSkip("RLS: F0 階層基盤テーブル (#48-A)", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const sql = createSql(url!);
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;
  let classA: string;

  beforeAll(async () => {
    fx = await seedBaseFixture(sql);
    // 各校に学年を 1 件ずつ (BYPASSRLS = テーブル所有者接続)
    await sql`INSERT INTO grades (school_id, name, display_order) VALUES (${fx.schoolA}, '1年', 1)`;
    await sql`INSERT INTO grades (school_id, name, display_order) VALUES (${fx.schoolB}, '1年', 1)`;
    // 各校に school スコープ広告を 1 件ずつ
    await sql`
      INSERT INTO ads (school_id, scope, media_url, media_type)
      VALUES (${fx.schoolA}, 'school', 'https://example.com/a.png', 'image')
    `;
    await sql`
      INSERT INTO ads (school_id, scope, media_url, media_type)
      VALUES (${fx.schoolB}, 'school', 'https://example.com/b.png', 'image')
    `;
    // class スコープ検証用にクラスを 1 件 (school A)
    const [c] = await sql<{ id: string }[]>`
      INSERT INTO classes (school_id, academic_year, name, grade)
      VALUES (${fx.schoolA}, 2026, '1-A', 1)
      RETURNING id
    `;
    classA = c.id;
  });

  beforeEach(async () => {
    await sql`RESET ROLE`;
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  it("grades: school A context は A の学年のみ可視", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
      await tx`SELECT set_config('app.current_user_role', 'school_admin', true)`;

      const rows = await tx<{ school_id: string }[]>`SELECT school_id FROM grades`;
      expect(rows.length).toBe(1);
      expect(rows[0].school_id).toBe(fx.schoolA);
    });
  });

  it("grades: school B context は B の学年のみ可視 (別テナントは見えない)", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_school_id', ${fx.schoolB}, true)`;
      await tx`SELECT set_config('app.current_user_role', 'school_admin', true)`;

      const rows = await tx<{ school_id: string }[]>`SELECT school_id FROM grades`;
      expect(rows.length).toBe(1);
      expect(rows[0].school_id).toBe(fx.schoolB);
    });
  });

  it("grades: context 未設定 → 全件拒否 (0 件、deny by default)", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      const rows = await tx<{ school_id: string }[]>`SELECT school_id FROM grades`;
      expect(rows.length).toBe(0);
    });
  });

  it("grades: 他テナント school_id で INSERT は WITH CHECK で拒否", async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
        await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
        await tx`SELECT set_config('app.current_user_role', 'school_admin', true)`;
        await tx`INSERT INTO grades (school_id, name, display_order) VALUES (${fx.schoolB}, '詐称学年', 9)`;
      }),
    ).rejects.toThrow(/row-level security|new row violates/i);
  });

  it("ads: school A context は A の広告のみ可視", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
      await tx`SELECT set_config('app.current_user_role', 'school_admin', true)`;

      const rows = await tx<{ media_url: string }[]>`SELECT media_url FROM ads`;
      expect(rows.length).toBe(1);
      expect(rows[0].media_url).toBe("https://example.com/a.png");
    });
  });

  it("ads: system_admin は cross-tenant で全広告が見える", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_user_role', 'system_admin', true)`;

      const rows = await tx<{ id: string }[]>`SELECT id FROM ads`;
      expect(rows.length).toBe(2);
    });
  });

  it("daily_data: scope='class' で class_id NULL は CHECK 制約 (ck_daily_data_scope) で拒否", async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
        await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
        await tx`SELECT set_config('app.current_user_role', 'school_admin', true)`;
        await tx`INSERT INTO daily_data (school_id, scope, date) VALUES (${fx.schoolA}, 'class', '2026-05-30')`;
      }),
    ).rejects.toThrow(/ck_daily_data_scope|check constraint/i);
  });

  it("daily_data: scope='class' + class_id 指定なら INSERT 可、A context で可視", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
      await tx`SELECT set_config('app.current_user_role', 'school_admin', true)`;
      await tx`
        INSERT INTO daily_data (school_id, scope, class_id, date)
        VALUES (${fx.schoolA}, 'class', ${classA}, '2026-05-30')
      `;
      const rows = await tx<{ id: string }[]>`SELECT id FROM daily_data`;
      expect(rows.length).toBe(1);
    });
  });

  it("school_configs: school スコープ同 kind 重複は UNIQUE NULLS NOT DISTINCT で拒否", async () => {
    // 1 件目 (BYPASSRLS で投入)
    await sql`
      INSERT INTO school_configs (school_id, scope, kind, value)
      VALUES (${fx.schoolB}, 'school', 'quiet_hours', '{}'::jsonb)
    `;
    // 2 件目 — *_id がすべて NULL でも NULLS NOT DISTINCT により一意制約が効く
    await expect(
      sql`
        INSERT INTO school_configs (school_id, scope, kind, value)
        VALUES (${fx.schoolB}, 'school', 'quiet_hours', '{}'::jsonb)
      `,
    ).rejects.toThrow(/ux_school_configs_target|duplicate key|unique/i);
  });
});
