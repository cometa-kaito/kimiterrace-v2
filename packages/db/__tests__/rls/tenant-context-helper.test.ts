import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, withTenantContext } from "../../src/client.js";
import { contents } from "../../src/schema/index.js";
import { getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * #48-B core: withTenantContext (RLS SET LOCAL primitive) の挙動を実 PG で検証する。
 * 接続は DATABASE_URL の superuser (BYPASSRLS) なので、appRole で kimiterrace_app へ
 * 降格してから RLS を効かせる (本番は最初から kimiterrace_app 接続のため appRole 不要)。
 */
describeOrSkip("withTenantContext (RLS テナントコンテキスト primitive)", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const { sql: raw, db } = createDbClient(url!);
  const APP = { appRole: "kimiterrace_app" };
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;

  beforeAll(async () => {
    fx = await seedBaseFixture(raw);
    // school A / B に published コンテンツを 1 件ずつ (BYPASSRLS 接続で投入)
    await raw`
      INSERT INTO contents (school_id, title, body, publish_scope, status)
      VALUES (${fx.schoolA}, 'A の告知', 'A 本文', 'school', 'published')
    `;
    await raw`
      INSERT INTO contents (school_id, title, body, publish_scope, status)
      VALUES (${fx.schoolB}, 'B の告知', 'B 本文', 'school', 'published')
    `;
  });

  beforeEach(async () => {
    await raw`RESET ROLE`;
  });

  afterAll(async () => {
    await raw.end({ timeout: 5 });
  });

  it("schoolId = A + role 設定 → A のレコードのみ可視 (drizzle select 経由)", async () => {
    const rows = await withTenantContext(
      db,
      { schoolId: fx.schoolA, role: "school_admin", userId: fx.userA },
      (tx) => tx.select({ title: contents.title, schoolId: contents.schoolId }).from(contents),
      APP,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].schoolId).toBe(fx.schoolA);
    expect(rows[0].title).toBe("A の告知");
  });

  it("schoolId = B → B のレコードのみ可視 (別テナント不可視)", async () => {
    const rows = await withTenantContext(
      db,
      { schoolId: fx.schoolB, role: "school_admin" },
      (tx) => tx.select({ title: contents.title }).from(contents),
      APP,
    );
    expect(rows.map((r) => r.title)).toEqual(["B の告知"]);
  });

  it("空コンテキスト {} → deny-by-default で 0 件 (set_config しない → RLS 拒否)", async () => {
    const rows = await withTenantContext(
      db,
      {},
      (tx) => tx.select({ title: contents.title }).from(contents),
      APP,
    );
    expect(rows.length).toBe(0);
  });

  it("role = system_admin (schoolId 未指定) → cross-tenant で全件可視", async () => {
    const rows = await withTenantContext(
      db,
      { role: "system_admin" },
      (tx) => tx.select({ title: contents.title }).from(contents).orderBy(contents.title),
      APP,
    );
    expect(rows.map((r) => r.title)).toEqual(["A の告知", "B の告知"]);
  });

  it("3 つの GUC (user_id / school_id / role) が set_config される", async () => {
    const got = await withTenantContext(
      db,
      { userId: fx.userA, schoolId: fx.schoolA, role: "teacher" },
      async (tx) => {
        const r = await tx.execute(sql`
          select
            current_setting('app.current_user_id', true)   as user_id,
            current_setting('app.current_school_id', true) as school_id,
            current_setting('app.current_user_role', true) as role
        `);
        return r[0] as { user_id: string; school_id: string; role: string };
      },
      APP,
    );
    expect(got.user_id).toBe(fx.userA);
    expect(got.school_id).toBe(fx.schoolA);
    expect(got.role).toBe("teacher");
  });

  it("コンテキストはトランザクションスコープ (前回の SET LOCAL が次回に漏れない)", async () => {
    // 1 回目: school A コンテキストで 1 件見える
    const first = await withTenantContext(
      db,
      { schoolId: fx.schoolA, role: "school_admin" },
      (tx) => tx.select({ title: contents.title }).from(contents),
      APP,
    );
    expect(first.length).toBe(1);

    // 2 回目: 空コンテキスト → 前回の school A が残っていれば 1 件見えてしまう。0 件であること。
    const second = await withTenantContext(
      db,
      {},
      (tx) => tx.select({ title: contents.title }).from(contents),
      APP,
    );
    expect(second.length).toBe(0);
  });

  it("コールバックの戻り値をそのまま返す", async () => {
    const result = await withTenantContext(
      db,
      { role: "system_admin" },
      async () => ({ ok: true as const, n: 42 }),
      APP,
    );
    expect(result).toEqual({ ok: true, n: 42 });
  });

  it("不正な appRole 名は実行前に例外", async () => {
    await expect(
      withTenantContext(db, { role: "system_admin" }, async () => 1, {
        appRole: "app; DROP ROLE postgres",
      }),
    ).rejects.toThrow(/不正な appRole/);
  });
});
