import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, withTenantContext } from "../../src/client.js";
import { createTvDevice } from "../../src/queries/tv-devices.js";
import { createSql, getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * F15 §4.3 (ADR-022 / ADR-019): TV デバイス新規登録 `createTvDevice` の RLS テナント分離を検証する。
 *
 * 新規登録は **system_admin 限定**（app 層 = onboarding-actions の requireRole）だが、DB 層の RLS も
 * 多層防御で cross-tenant 登録を制御する:
 *  - **system_admin context は任意校に INSERT 可**（system_admin_full_access WITH CHECK）= 正規の登録経路。
 *  - **school_admin context は自校のみ INSERT 可**（tenant_isolation WITH CHECK）。別校 school_id を渡すと
 *    WITH CHECK 違反で拒否（万一 school_admin が seam を呼んでも越境登録できない）。
 *  - **device_id グローバル UNIQUE**: 別校が同一 device_id を登録できない（ポーリング解決の一意性）。
 *
 * 実 PG（DATABASE_URL）でのみ走り、未設定ならスキップ（ADR-012）。ドメイン関数はテスト superuser 接続を
 * `appRole: 'kimiterrace_app'` で降格させ RLS を実際に効かせる（さもないと vacuous）。`sql`（BYPASSRLS）は
 * シード/検証専用。created_by は system_admin が users 行でないため null（onboarding-actions と同パターン）。
 */
describeOrSkip("RLS: F15 createTvDevice", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const sql = createSql(url!);
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const { sql: dbSql, db } = createDbClient(url!);
  const APP = { appRole: "kimiterrace_app" } as const;
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;

  /** 登録入力の最小形（設定フィールドは null / 既定）。device_id ごとにユニーク化して衝突を避ける。 */
  function input(deviceId: string, schoolId: string) {
    return {
      deviceId,
      schoolId,
      label: "電子工学科 1年",
      targetMac: null,
      signageUrl: "https://sig.example/?x=1",
      webhookUrl: null,
      scheduleJson: null,
      monitoringEnabled: true,
      notes: null,
      createdBy: null,
    };
  }

  beforeAll(async () => {
    fx = await seedBaseFixture(sql);
  });

  beforeEach(async () => {
    await sql`RESET ROLE`;
  });

  afterAll(async () => {
    await dbSql.end({ timeout: 5 });
    await sql.end({ timeout: 5 });
  });

  it("system_admin context は任意校（schoolB）に登録できる（cross-tenant）", async () => {
    const dev = "aaaaaaa1-1111-4111-8111-111111111111";
    const ref = await withTenantContext(
      db,
      { role: "system_admin" },
      (tx) => createTvDevice(tx, input(dev, fx.schoolB)),
      APP,
    );
    expect(ref.deviceId).toBe(dev);

    // BYPASSRLS で実在と所属校を検証。
    const rows = await sql<{ school_id: string; created_by: string | null }[]>`
      SELECT school_id, created_by FROM tv_devices WHERE device_id = ${dev}
    `;
    expect(rows.length).toBe(1);
    expect(rows[0].school_id).toBe(fx.schoolB);
    expect(rows[0].created_by).toBeNull();
  });

  it("school_admin context は自校（schoolA）になら登録できる", async () => {
    const dev = "aaaaaaa2-2222-4222-8222-222222222222";
    const ref = await withTenantContext(
      db,
      { role: "school_admin", schoolId: fx.schoolA, userId: fx.userA },
      (tx) => createTvDevice(tx, { ...input(dev, fx.schoolA), createdBy: fx.userA }),
      APP,
    );
    expect(ref.deviceId).toBe(dev);
    const rows = await sql<{ school_id: string }[]>`
      SELECT school_id FROM tv_devices WHERE device_id = ${dev}
    `;
    expect(rows[0]?.school_id).toBe(fx.schoolA);
  });

  it("school_admin context が別校（schoolB）に登録しようとすると RLS WITH CHECK で拒否", async () => {
    const dev = "aaaaaaa3-3333-4333-8333-333333333333";
    await expect(
      withTenantContext(
        db,
        { role: "school_admin", schoolId: fx.schoolA, userId: fx.userA },
        (tx) => createTvDevice(tx, { ...input(dev, fx.schoolB), createdBy: fx.userA }),
        APP,
      ),
    ).rejects.toThrow();

    // 拒否されたので行は存在しない。
    const rows = await sql<{ device_id: string }[]>`
      SELECT device_id FROM tv_devices WHERE device_id = ${dev}
    `;
    expect(rows.length).toBe(0);
  });

  it("同一 device_id の二重登録はグローバル UNIQUE で拒否（別校でも不可）", async () => {
    const dev = "aaaaaaa4-4444-4444-8444-444444444444";
    await withTenantContext(
      db,
      { role: "system_admin" },
      (tx) => createTvDevice(tx, input(dev, fx.schoolA)),
      APP,
    );
    // 別校で同一 device_id → 23505。Drizzle は driver エラーを DrizzleQueryError で包むため SQLSTATE は
    // トップレベルでなく cause 側に乗る（ラップ無し・有り両対応で取り出す）。
    const err = await withTenantContext(
      db,
      { role: "system_admin" },
      (tx) => createTvDevice(tx, input(dev, fx.schoolB)),
      APP,
    ).catch((e: unknown) => e);
    const code =
      (err as { code?: string })?.code ?? (err as { cause?: { code?: string } })?.cause?.code;
    expect(code).toBe("23505");
  });
});
