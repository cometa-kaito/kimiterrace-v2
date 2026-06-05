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
 *   3. **並行再送（TOCTOU）**を同時発火 → events は 1 件のみ（#567 の本丸を決定的に固定）。
 *   4. timeOfSampleMs=null の再送 → 受信時刻 now() で別行記録（#437 の意図的設計、dedup 対象外）。
 *
 * ## #567 修正: 並行再送 TOCTOU を DB の部分 UNIQUE index で直列化
 *
 * app 層 dedup（事前 SELECT→INSERT）は行ロックでも UNIQUE でもないため、**同時刻の 2 つの同一再送が
 * 両方 SELECT で 0 行を観測 → 両方 INSERT** する phantom race（READ COMMITTED）が起きうる。#567 で
 * `events` に部分 UNIQUE index `ux_events_presence_dedup` (school_id, payload->>'device_mac',
 * occurred_at) WHERE type='presence' を追加し、`recordPresenceEvent` の INSERT を `ON CONFLICT DO
 * NOTHING` で原子化した。これにより 2 つの並行再送が SELECT を素通りしても DB が INSERT を直列化し、
 * 先着のみ recorded・後着は duplicate になる。**勝者非依存の不変条件（events=1 件）**で断言するため、
 * 並行スケジューリングに依存せず決定的（[[feedback_realpg_concurrency_test_deterministic]] と同方針）。
 *
 * ## null-ts は #437 の意図的トレードオフ（dedup 対象外、ここでは仕様として固定）
 *
 * `timeOfSampleMs=null` は「タイムスタンプ未送」だけでなく、**#437 Low-1 の時刻注入緩和**で sane window
 * 外の時刻を受信時刻に倒した検知でもある（occurred_at 汚染を無力化しつつ「検知は捨てない」）。これらは
 * occurred_at=now() で毎回別値になり本 UNIQUE index では衝突しない＝ #437 設計どおり別行で記録される
 * （行数膨張は IP レート制限が律速）。#567 の「null は reject せよ」案は **#437 の検知保持を退行**させる
 * ため採らない（authoritative な ADR-020/#437 が issue 提案に優先、[[feedback_verify_design_against_adr_before_build]]）。
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

  it("並行再送（TOCTOU）: 同一 timestamped 再送を同時発火しても events は 1 件（ON CONFLICT が直列化、#567）", async () => {
    // #567 の本丸。2 つの同一再送を Promise.all で同時発火する。各 recordPresenceEvent は別 tx
    // （pool の別接続）で走り、両者が app 層の事前 SELECT で 0 行を観測しても、部分 UNIQUE index
    // ux_events_presence_dedup が INSERT を直列化する（READ COMMITTED の phantom race を封鎖）。
    const input = {
      deviceMac: "AABBCCDDEE01",
      detectionState: "DETECTED",
      timeOfSampleMs: T,
      eventVersion: null,
    };
    const [a, b] = await Promise.all([
      recordPresenceEvent(db, input, APP),
      recordPresenceEvent(db, input, APP),
    ]);
    // 勝者非依存の不変条件: ちょうど 1 件 recorded・1 件 duplicate、events は 1 行のみ（timing 非依存）。
    // 修正前は両方 SELECT 0 行 → 両方 INSERT で 2 件になりえた（TOCTOU 二重計上）。
    expect([a.status, b.status].sort()).toEqual(["duplicate", "recorded"]);
    expect(await countPresenceAs(fx.schoolA)).toBe(1);
  });

  it("timeOfSampleMs=null は #437 設計どおり受信時刻 now() で別行記録される（dedup 対象外）", async () => {
    // null-ts は「未送」だけでなく #437 Low-1 で sane window 外の時刻を受信時刻に倒した検知でもある。
    // occurred_at=now()（tx ごとに別値）で本 UNIQUE index に衝突せず別行で記録される＝ #437 の
    // 「検知を捨てず受信時刻で記録・行数膨張は IP レート制限が律速」設計の固定（#567 で reject しない）。
    const input = {
      deviceMac: "AABBCCDDEE01",
      detectionState: "DETECTED",
      timeOfSampleMs: null,
      eventVersion: null,
    };
    const r1 = await recordPresenceEvent(db, input, APP);
    const r2 = await recordPresenceEvent(db, input, APP);
    expect(r1.status).toBe("recorded");
    expect(r2.status).toBe("recorded"); // null-ts は dedup 対象外（#437 設計）
    expect(await countPresenceAs(fx.schoolA)).toBe(2);
  });
});
