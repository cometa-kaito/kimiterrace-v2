import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type postgres from "postgres";
import { createSql, getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

/**
 * F07 (#43, CLAUDE.md ルール2): `events` テーブル（view/tap/dwell/ask/presence の行動ログ）の
 * RLS テナント分離を実 PG で検証する。
 *
 * events は最高頻度の書込みテーブル（全サイネージの閲覧/タップ/滞在/質問が 1 行）。集計 read の
 * 分離は `event-stats.test.ts`（getEventStats）が担保するが、**テーブルへの直接 INSERT 越境
 * (WITH CHECK) / 直接 SELECT・UPDATE・DELETE の分離は未テスト**だった。ingest route (#258) が
 * school_id を取り違える / WHERE が抜けるバグを踏んでも、DB レベルで越境を止めることを pin する。
 *
 * RLS policy (0002_rls_policies.sql):
 * - `tenant_isolation FOR ALL`: USING + WITH CHECK = `school_id = current_setting('app.current_school_id')`
 * - `system_admin_full_access FOR ALL`: role=system_admin なら全校
 *
 * **非 vacuous 化**: superuser 接続を `SET LOCAL ROLE kimiterrace_app` で降格し RLS を実際に効かせる
 * (降格しないと BYPASSRLS で全件見え、分離アサートが空振りする)。tenant-isolation.test.ts と同形。
 * DATABASE_URL 未設定ならローカルは skip、CI (実 PG16) で実行。
 */

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

type Ctx = { schoolId?: string; role?: string };

describeOrSkip("F07 events RLS テナント分離 (直接 read/write 越境防止、ルール2)", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const sql = createSql(url!);
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;

  /** kimiterrace_app へ降格し RLS context を張った tx 内で fn を実行する (SET LOCAL = tx スコープ)。 */
  async function asApp<T>(ctx: Ctx, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
    return sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      if (ctx.schoolId) await tx`SELECT set_config('app.current_school_id', ${ctx.schoolId}, true)`;
      if (ctx.role) await tx`SELECT set_config('app.current_user_role', ${ctx.role}, true)`;
      return fn(tx);
    }) as Promise<T>;
  }

  /** events の全行数を school 別に数える (superuser, RLS バイパス)。 */
  async function countBySchool(schoolId: string): Promise<number> {
    const [r] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM events WHERE school_id = ${schoolId}
    `;
    return r.n;
  }

  beforeAll(async () => {
    fx = await seedBaseFixture(sql);
    // school A に 2 件 (view / tap)、school B に 1 件 (view)。content_id は NULL で十分 (分離の核心は
    // school_id ベース)。occurred_at は default now()。
    await sql`INSERT INTO events (school_id, type) VALUES (${fx.schoolA}, 'view')`;
    await sql`INSERT INTO events (school_id, type) VALUES (${fx.schoolA}, 'tap')`;
    await sql`INSERT INTO events (school_id, type) VALUES (${fx.schoolB}, 'view')`;
  });

  beforeEach(async () => {
    await sql`RESET ROLE`;
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  it("read 分離: A context は自校 events のみ可視 (B は不可視)", async () => {
    const rows = await asApp(
      { schoolId: fx.schoolA, role: "school_admin" },
      (tx) => tx<{ school_id: string }[]>`SELECT school_id FROM events`,
    );
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.school_id === fx.schoolA)).toBe(true);
  });

  it("read 分離: B context は自校 events のみ可視 (A は不可視)", async () => {
    const rows = await asApp(
      { schoolId: fx.schoolB, role: "school_admin" },
      (tx) => tx<{ school_id: string }[]>`SELECT school_id FROM events`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].school_id).toBe(fx.schoolB);
  });

  it("system_admin_full_access: system_admin は全校 events を可視", async () => {
    const rows = await asApp(
      { role: "system_admin" },
      (tx) => tx<{ school_id: string }[]>`SELECT school_id FROM events`,
    );
    // A の 2 件 + B の 1 件 = 全 3 件が見える
    expect(rows.length).toBe(3);
    const schools = new Set(rows.map((r) => r.school_id));
    expect(schools.has(fx.schoolA)).toBe(true);
    expect(schools.has(fx.schoolB)).toBe(true);
  });

  it("越境 write 禁止 (WITH CHECK): A context から school_id=B の event は INSERT 不可", async () => {
    await expect(
      asApp(
        { schoolId: fx.schoolA, role: "school_admin" },
        (tx) => tx`INSERT INTO events (school_id, type) VALUES (${fx.schoolB}, 'view')`,
      ),
      // WITH CHECK 違反は PG が "new row violates row-level security policy" で reject する
    ).rejects.toThrow(/row-level security/i);
    // B の件数は増えていない (tx rollback)
    expect(await countBySchool(fx.schoolB)).toBe(1);
  });

  it("越境 update/delete 不可 (USING で silent 0-row): A context から B の events は変更不可", async () => {
    const updated = await asApp({ schoolId: fx.schoolA, role: "school_admin" }, async (tx) => {
      const u =
        await tx`UPDATE events SET payload = '{"x":1}'::jsonb WHERE school_id = ${fx.schoolB}`;
      return u.count;
    });
    expect(updated).toBe(0);

    const deleted = await asApp({ schoolId: fx.schoolA, role: "school_admin" }, async (tx) => {
      const d = await tx`DELETE FROM events WHERE school_id = ${fx.schoolB}`;
      return d.count;
    });
    expect(deleted).toBe(0);
    // B の event は残存
    expect(await countBySchool(fx.schoolB)).toBe(1);
  });

  it("deny-by-default: 空コンテキストは SELECT 0 件 / INSERT 不可", async () => {
    const rows = await asApp({}, (tx) => tx<{ id: string }[]>`SELECT id FROM events`);
    expect(rows.length).toBe(0);

    await expect(
      asApp({}, (tx) => tx`INSERT INTO events (school_id, type) VALUES (${fx.schoolA}, 'view')`),
    ).rejects.toThrow(/row-level security/i);
  });

  it("自校 write 可: A context は school_id=A の event を INSERT できる", async () => {
    const before = await countBySchool(fx.schoolA);
    await asApp(
      { schoolId: fx.schoolA, role: "school_admin" },
      (tx) => tx`INSERT INTO events (school_id, type) VALUES (${fx.schoolA}, 'dwell')`,
    );
    expect(await countBySchool(fx.schoolA)).toBe(before + 1);
  });
});
