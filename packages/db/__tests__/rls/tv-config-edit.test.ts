import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, withTenantContext } from "../../src/client.js";
import { getTvDeviceConfig, updateTvDeviceConfig } from "../../src/queries/tv-devices.js";
import { createSql, getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * F15 §4.2 (ADR-022): TV デバイス設定編集（`updateTvDeviceConfig` / `getTvDeviceConfig`）の RLS テナント
 * 分離 + version バンプ + updated_at 前進を検証する。
 *
 * - 自校デバイスは編集成功（version +1、updated_at 前進、updated_by 記録）
 * - 他校デバイスへの UPDATE は RLS（tenant_isolation）で **0 行** → undefined（cross-tenant deny）
 * - getTvDeviceConfig も他校は不可視 → undefined（編集ページの notFound 経路）
 * - ソフトデリート済（deleted_at）は編集対象外
 * - jsonb（schedule_json）は `::jsonb` で bind、タイムスタンプ前進は DB 側 now()-make_interval で seed
 *
 * 実 PG（DATABASE_URL）でのみ走り、未設定ならスキップ（ADR-012）。ドメイン関数は `appRole:
 * 'kimiterrace_app'` で test superuser を降格させ **RLS を実際に効かせる**（さもないと vacuous）。
 * `sql`（BYPASSRLS スーパーユーザー）はシード/検証専用。device_id 定数は他テストと衝突しない
 * `f15edit-*` 系の UUID を使う（共有 DB での衝突回避）。
 */
describeOrSkip("RLS: F15 tv_devices config edit", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const sql = createSql(url!);
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const { sql: dbSql, db } = createDbClient(url!);
  const APP = { appRole: "kimiterrace_app" } as const;
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;

  // 他テストファイル（tv-devices.test.ts の 1111…/2222…）と重ならない f15edit- 系の UUID。
  const DEV_A = "f15ed17a-0000-4000-8000-0000000000a1";
  const DEV_B = "f15ed17b-0000-4000-8000-0000000000b2";
  const DEV_DEL = "f15ed17d-0000-4000-8000-0000000000d3";
  // 編集対象の行 PK（id）。RETURNING で受けて再利用する。
  let rowIdA = "";
  let rowIdB = "";
  let rowIdDel = "";

  beforeAll(async () => {
    fx = await seedBaseFixture(sql);
    // 各校に TV 1 台 + A 校に退役 TV 1 台（BYPASSRLS = テーブル所有者接続でシード）。
    // updated_at は「設定変更で前進」を検証するため、過去（now-1day）に固定して seed する
    // （JS Date を timestamptz に bind しない: DB 側 now()-make_interval で算出、enum 列含む INSERT の罠回避）。
    const [a] = await sql<{ id: string }[]>`
      INSERT INTO tv_devices (school_id, device_id, label, signage_url, target_mac, version, schedule_json, updated_at)
      VALUES (
        ${fx.schoolA}, ${DEV_A}, '電子工学科 1年', 'https://sig.example/?school=A', 'DC:A5:B3:C2:98:A1', 5,
        ${JSON.stringify({ enabled: true, onHour: 7 })}::jsonb,
        now() - make_interval(days => 1::int)
      )
      RETURNING id
    `;
    rowIdA = a.id;
    const [b] = await sql<{ id: string }[]>`
      INSERT INTO tv_devices (school_id, device_id, label, signage_url, version, updated_at)
      VALUES (${fx.schoolB}, ${DEV_B}, '職員室', 'https://sig.example/?school=B', 2, now() - make_interval(days => 1::int))
      RETURNING id
    `;
    rowIdB = b.id;
    const [del] = await sql<{ id: string }[]>`
      INSERT INTO tv_devices (school_id, device_id, label, version, deleted_at)
      VALUES (${fx.schoolA}, ${DEV_DEL}, '退役 TV', 1, now())
      RETURNING id
    `;
    rowIdDel = del.id;
  });

  beforeEach(async () => {
    await sql`RESET ROLE`;
  });

  afterAll(async () => {
    await dbSql.end({ timeout: 5 });
    await sql.end({ timeout: 5 });
  });

  it("自校デバイスを更新: version +1 / updated_at 前進 / updated_by 記録 / 設定反映", async () => {
    // 編集前のスナップショット（BYPASSRLS で素読み）。
    const before = await sql<{ version: number; updated_at: string }[]>`
      SELECT version, updated_at FROM tv_devices WHERE id = ${rowIdA}
    `;
    expect(before[0].version).toBe(5);
    const beforeUpdatedAt = new Date(before[0].updated_at).getTime();

    const ref = await withTenantContext(
      db,
      { schoolId: fx.schoolA, role: "school_admin", userId: fx.userA },
      (tx) =>
        updateTvDeviceConfig(tx, {
          id: rowIdA,
          patch: {
            label: "電子工学科 2年",
            signageUrl: "https://sig.example/?school=A&grade=2",
            scheduleJson: { enabled: true, onHour: 8, offHour: 18 },
          },
          actorUserId: fx.userA,
        }),
      APP,
    );
    expect(ref).toBeDefined();
    // version は +1（5 → 6）。
    expect(ref?.version).toBe(6);

    // 反映 + 監査列を BYPASSRLS で検証。
    const after = await sql<
      {
        label: string | null;
        signage_url: string | null;
        schedule_json: { enabled: boolean; onHour?: number; offHour?: number } | null;
        version: number;
        updated_at: string;
        updated_by: string | null;
      }[]
    >`
      SELECT label, signage_url, schedule_json, version, updated_at, updated_by
      FROM tv_devices WHERE id = ${rowIdA}
    `;
    expect(after[0].label).toBe("電子工学科 2年");
    expect(after[0].signage_url).toBe("https://sig.example/?school=A&grade=2");
    expect(after[0].schedule_json).toEqual({ enabled: true, onHour: 8, offHour: 18 });
    expect(after[0].version).toBe(6);
    expect(after[0].updated_by).toBe(fx.userA);
    // updated_at が作成時刻（now-1day）より前進している（[[updatedat-explicit-on-update]] 回帰防止）。
    expect(new Date(after[0].updated_at).getTime()).toBeGreaterThan(beforeUpdatedAt);
  });

  it("他校デバイスへの UPDATE は RLS で 0 行 → undefined（cross-tenant deny）", async () => {
    // school A context で B 校の行 PK を狙っても、tenant_isolation で不可視 → 0 行。
    const ref = await withTenantContext(
      db,
      { schoolId: fx.schoolA, role: "school_admin", userId: fx.userA },
      (tx) =>
        updateTvDeviceConfig(tx, {
          id: rowIdB,
          patch: { label: "乗っ取り" },
          actorUserId: fx.userA,
        }),
      APP,
    );
    expect(ref).toBeUndefined();

    // B 校の行は一切変わっていない（version も label も不変、越境書き込みが起きていない）。
    const b = await sql<{ label: string | null; version: number }[]>`
      SELECT label, version FROM tv_devices WHERE id = ${rowIdB}
    `;
    expect(b[0].label).toBe("職員室");
    expect(b[0].version).toBe(2);
  });

  it("getTvDeviceConfig: 自校は取得、他校は不可視 → undefined", async () => {
    const own = await withTenantContext(
      db,
      { schoolId: fx.schoolA, role: "school_admin", userId: fx.userA },
      (tx) => getTvDeviceConfig(tx, rowIdA),
      APP,
    );
    expect(own?.id).toBe(rowIdA);

    const foreign = await withTenantContext(
      db,
      { schoolId: fx.schoolA, role: "school_admin", userId: fx.userA },
      (tx) => getTvDeviceConfig(tx, rowIdB),
      APP,
    );
    expect(foreign).toBeUndefined();
  });

  it("ソフトデリート済（deleted_at）は更新対象外 → undefined", async () => {
    const ref = await withTenantContext(
      db,
      { schoolId: fx.schoolA, role: "school_admin", userId: fx.userA },
      (tx) =>
        updateTvDeviceConfig(tx, {
          id: rowIdDel,
          patch: { label: "復活させない" },
          actorUserId: fx.userA,
        }),
      APP,
    );
    expect(ref).toBeUndefined();
    // getTvDeviceConfig も退役 TV を返さない。
    const got = await withTenantContext(
      db,
      { schoolId: fx.schoolA, role: "school_admin", userId: fx.userA },
      (tx) => getTvDeviceConfig(tx, rowIdDel),
      APP,
    );
    expect(got).toBeUndefined();
  });

  it("サニティ: BYPASSRLS で全件見え、cross-tenant deny が vacuous でない（B 校行は実在する）", async () => {
    const all = await sql<{ id: string }[]>`
      SELECT id FROM tv_devices WHERE id IN (${rowIdA}, ${rowIdB}, ${rowIdDel})
    `;
    // 3 行とも実在（= 上の cross-tenant deny は「行が無いから 0 行」ではなく RLS で弾かれている）。
    expect(all.length).toBe(3);
  });
});
