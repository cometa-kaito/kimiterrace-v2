import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDbClient } from "../../src/client.js";
import { recordPresenceEvent } from "../../src/queries/sensor-presence.js";
import { getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * T-02 / SEC-008: 状態変更（presence webhook）の再送リプレイで二重計上されないことの敵対監査。
 *
 * 対象 seam = `recordPresenceEvent`（`packages/db/src/queries/sensor-presence.ts`）。SwitchBot
 * webhook の在室イベント書込み。冪等 dedup は **`(device_mac, occurred_at)` を SELECT し、無ければ
 * INSERT** する app 層ロジック（同 L80-93）。既存 `sensor-webhook-ingest.test.ts` は逐次 1 回再送の
 * 冪等のみ pin する。本スイートはリプレイ攻撃の観点で敵対的に詰める:
 *
 *   1. 逐次 N 連送（同 MAC + 同 occurred_at）→ 2 回目以降 duplicate、events は 1 件のみ（正の対比）。
 *   2. detection_state だけ変えた再送 → dedup は (MAC, occurred_at) キーなので duplicate のまま。
 *      攻撃者が検知状態を反転して計上を水増しすることはできない（dedup キーの堅牢性）。
 *   3. timeOfSampleMs=null の再送 → dedup ブロックを丸ごとスキップ（L81）するため二重計上される。
 *      = 既知ギャップ（#567）。null-ts 経路は dedup されないことを characterization として固定する。
 *
 * ## 範囲正直: 並行再送（TOCTOU）はここでは「監査として明示」に留める（#567）
 *
 * app 層 dedup は SELECT→INSERT であり行ロックでも UNIQUE 制約でもない。`events` には presence
 * dedup キーの UNIQUE インデックスが存在しない（`events.ts` の index は非 unique）。よって
 * **同時刻の 2 つの同一再送が両方 dedup SELECT で 0 行を観測 → 両方 INSERT** し二重計上する
 * （READ COMMITTED の phantom race）。これは本テストでは**決定的に再現できない**（実 PG の
 * 並行スケジューリング依存で flaky になる）ため、敵対断言ではなく **#567 の監査項目**として明示し、
 * 修正（presence 用 partial UNIQUE index + `ON CONFLICT DO NOTHING`）は schema-token レーンに委ねる。
 * 本テストが固定するのは「逐次 dedup は機能する／detection_state で破れない／null-ts は素通り」の
 * 決定的な 3 点であり、並行ギャップは #567 で追跡する。#567 修正後は test 3 の断言（二重計上）を
 * 「1 件」へ更新すること。
 *
 * 実 PG（kimiterrace_app + RLS）が要るため DATABASE_URL 未設定ではスキップ（CI Test job で実走）。
 */
describeOrSkip("T-02 / SEC-008: presence 再送リプレイの冪等性 (recordPresenceEvent)", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const { sql, db } = createDbClient(url!);
  const APP = { appRole: "kimiterrace_app" } as const;
  const T = 1_700_000_000_000; // epoch ms（固定）
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;

  beforeEach(async () => {
    fx = await seedBaseFixture(sql);
    // school A: 稼働中デバイス（canonical 入力 AABBCCDDEE01 で解決される）。
    await sql`
      INSERT INTO sensor_devices (school_id, device_mac, location_label)
      VALUES (${fx.schoolA}, 'AA:BB:CC:DD:EE:01', '1-A 教室前')
    `;
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  /** 自校テナント context（非 BYPASSRLS）で presence events 件数を読む。 */
  async function countPresenceAs(schoolId: string): Promise<number> {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_school_id', ${schoolId}, true)`;
      await tx`SELECT set_config('app.current_user_role', 'school_admin', true)`;
      const rows = await tx<{ c: string }[]>`
        SELECT count(*)::text AS c FROM events WHERE type = 'presence'
      `;
      return Number(rows[0].c);
    });
  }

  it("逐次 3 連送（同 MAC + 同 occurred_at）→ 2回目以降 duplicate、events は 1 件のみ", async () => {
    const input = {
      deviceMac: "AABBCCDDEE01",
      detectionState: "DETECTED",
      timeOfSampleMs: T,
      eventVersion: null,
    };
    const r1 = await recordPresenceEvent(db, input, APP);
    const r2 = await recordPresenceEvent(db, input, APP);
    const r3 = await recordPresenceEvent(db, input, APP);
    expect(r1.status).toBe("recorded");
    expect(r2.status).toBe("duplicate");
    expect(r3.status).toBe("duplicate");
    expect(await countPresenceAs(fx.schoolA)).toBe(1);
  });

  it("detection_state だけ変えた再送は dedup を破れない（キーは MAC + occurred_at）", async () => {
    const base = { deviceMac: "AABBCCDDEE01", timeOfSampleMs: T, eventVersion: null };
    const r1 = await recordPresenceEvent(db, { ...base, detectionState: "DETECTED" }, APP);
    // 検知状態を反転しても (device_mac, occurred_at) が同じなら duplicate。状態反転で計上を
    // 水増しできない＝ dedup キーが detection_state に依存していないことを敵対的に固定。
    const r2 = await recordPresenceEvent(db, { ...base, detectionState: "NOT_DETECTED" }, APP);
    expect(r1.status).toBe("recorded");
    expect(r2.status).toBe("duplicate");
    expect(await countPresenceAs(fx.schoolA)).toBe(1);
  });

  it("【既知ギャップ #567】timeOfSampleMs=null の再送は dedup されず二重計上される", async () => {
    // sensor-presence.ts L81: dedup は occurred_at が非 null のときのみ。null-ts は dedup を
    // スキップするため、同一 MAC の null-ts 連送が二重計上される。本断言は現状（脆弱）の
    // characterization。#567（presence 用 partial UNIQUE index + null-ts の取り扱い明示）解決後は
    // toBe(1) へ更新すること。
    const input = {
      deviceMac: "AABBCCDDEE01",
      detectionState: "DETECTED",
      timeOfSampleMs: null,
      eventVersion: null,
    };
    const r1 = await recordPresenceEvent(db, input, APP);
    const r2 = await recordPresenceEvent(db, input, APP);
    expect(r1.status).toBe("recorded");
    expect(r2.status).toBe("recorded"); // dedup されない（null-ts 経路）
    expect(await countPresenceAs(fx.schoolA)).toBe(2);
  });
});
