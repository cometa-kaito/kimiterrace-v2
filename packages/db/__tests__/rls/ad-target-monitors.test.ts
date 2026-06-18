import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, withTenantContext } from "../../src/client.js";
import { adTargetMonitors } from "../../src/schema/ad-target-monitors.js";
import { getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * Phase5: ad_target_monitors（広告⇄個別モニタ中間表）の RLS を実 PG で検証する（ルール2・許可+拒否）。
 * ads と同じ二層（tenant_isolation + system_admin_full_access）。サイネージ配信読取は学校テナントロールで
 * 行うため、自校分のみ可視・越境 INSERT は WITH CHECK で拒否・system_admin は全校横断、を pin する。
 * 実 PG（DATABASE_URL）でのみ走り、未設定ならスキップ（ADR-012）。read は appRole で降格し RLS を実効化。
 */
describeOrSkip("RLS: ad_target_monitors（広告⇄個別モニタ）", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const { sql: raw, db } = createDbClient(url!);
  const APP = { appRole: "kimiterrace_app" } as const;
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;
  let adA: string;
  let adB: string;
  let monA: string;
  let monB: string;

  const ctxA = () => ({ userId: fx.userA, schoolId: fx.schoolA, role: "school_admin" as const });
  const ctxB = () => ({ userId: fx.userB, schoolId: fx.schoolB, role: "school_admin" as const });
  const ctxAdmin = () => ({ userId: null, schoolId: null, role: "system_admin" as const });

  async function seedAd(schoolId: string): Promise<string> {
    const [r] = await raw<{ id: string }[]>`
      INSERT INTO ads (school_id, scope, media_url, media_type)
      VALUES (${schoolId}, 'monitor', 'https://storage.googleapis.com/b/a.png', 'image')
      RETURNING id`;
    return r.id;
  }
  async function seedMonitor(schoolId: string, deviceId: string): Promise<string> {
    const [r] = await raw<{ id: string }[]>`
      INSERT INTO tv_devices (device_id, school_id) VALUES (${deviceId}, ${schoolId}) RETURNING id`;
    return r.id;
  }

  beforeAll(async () => {
    fx = await seedBaseFixture(raw);
  });

  beforeEach(async () => {
    await raw`RESET ROLE`;
    await raw`DELETE FROM ad_target_monitors`;
    await raw`DELETE FROM ads`;
    await raw`DELETE FROM tv_devices WHERE school_id IN (${fx.schoolA}, ${fx.schoolB})`;
    adA = await seedAd(fx.schoolA);
    adB = await seedAd(fx.schoolB);
    monA = await seedMonitor(fx.schoolA, "rls-dev-a");
    monB = await seedMonitor(fx.schoolB, "rls-dev-b");
    await raw`INSERT INTO ad_target_monitors (ad_id, monitor_id, school_id) VALUES (${adA}, ${monA}, ${fx.schoolA})`;
    await raw`INSERT INTO ad_target_monitors (ad_id, monitor_id, school_id) VALUES (${adB}, ${monB}, ${fx.schoolB})`;
  });

  afterAll(async () => {
    await raw.end({ timeout: 5 });
  });

  it("テナント分離: 各校コンテキストは自校の紐付けのみ可視（SELECT）", async () => {
    const rowsA = await withTenantContext(
      db,
      ctxA(),
      (tx) => tx.select().from(adTargetMonitors),
      APP,
    );
    expect(rowsA.map((r) => r.schoolId)).toEqual([fx.schoolA]);

    const rowsB = await withTenantContext(
      db,
      ctxB(),
      (tx) => tx.select().from(adTargetMonitors),
      APP,
    );
    expect(rowsB.map((r) => r.schoolId)).toEqual([fx.schoolB]);
  });

  it("system_admin は全校横断で可視（Partner K3 の書込前提）", async () => {
    const rows = await withTenantContext(
      db,
      ctxAdmin(),
      (tx) => tx.select().from(adTargetMonitors),
      APP,
    );
    expect(rows.length).toBe(2);
  });

  it("越境 INSERT は WITH CHECK で拒否（A コンテキストから B 校の行）", async () => {
    await expect(
      withTenantContext(
        db,
        ctxA(),
        (tx) =>
          tx.insert(adTargetMonitors).values({
            adId: adB,
            monitorId: monB,
            schoolId: fx.schoolB,
            createdBy: null,
            updatedBy: null,
          }),
        APP,
      ),
    ).rejects.toThrow();
  });
});
