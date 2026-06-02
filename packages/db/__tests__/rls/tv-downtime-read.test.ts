import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, withTenantContext } from "../../src/client.js";
import {
  getTvDeviceIdentity,
  getTvUptimeSummary,
  listTvDeviceDowntime,
} from "../../src/queries/tv-downtime.js";
import { createSql, getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * F16 §5 (ADR-023): TV ダウンタイム履歴 / 稼働サマリ読み取り層（listTvDeviceDowntime /
 * getTvUptimeSummary / getTvDeviceIdentity）を実 PG で検証する。
 *
 * 観点:
 *  1. **テナント分離（非 vacuous）**: school_admin 自校 context は自校 TV のダウンタイムのみ可視。
 *     **他校 TV の device_id を直接渡しても 0 件**（RLS が弾く）。BYPASSRLS sanity で「他校行は実在する」
 *     ことを確認し、deny が「そもそも行が無いから空」でないこと（非 vacuous）を担保する。
 *  2. **system_admin cross-tenant**: 全校のダウンタイムが可視。
 *  3. **決定的順序**: desc(went_down_at), desc(id) の複合キー tiebreak（同時刻 tie でも安定、PR #492/#499）。
 *  4. **稼働サマリ集計**: 窓内の総ダウン秒数（復帰済み duration_sec + 継続中 now()-went_down_at）+ 件数。
 *
 * RLS を実際に効かせるため、テスト superuser 接続を `appRole: 'kimiterrace_app'` で降格させる
 * （`tenantScopedContext` 相当に school_admin role を張る）。さもないと vacuous（[[realpg ...]]）。
 * `sql`（BYPASSRLS）はシード/検証専用、`db`（appRole 降格）はドメイン関数用。
 * 時刻は JS Date を bind せず DB 側 `now() - make_interval(...)` で算出（[[pg-date-bind-enum-insert]]）。
 *
 * UUID は他テスト（tv-device-downtime.test.ts の 1111.. / 2222..）と衝突しない値を使う（共有単一フォーク DB）。
 */
describeOrSkip("RLS: F16 tv_device_downtime 読み取り層（履歴 / 稼働サマリ）", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const sql = createSql(url!);
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const { sql: dbSql, db } = createDbClient(url!);
  const APP = { appRole: "kimiterrace_app" } as const;
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;

  // このファイル専用の device_id（他 RLS テストと非衝突）。
  const DEV_A = "aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa";
  const DEV_B = "bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb";
  // 行 PK は固定して getTvDeviceIdentity の参照軸を決定的にする。
  const ROW_A = "cccccccc-1111-4ccc-8ccc-cccccccccccc";
  const ROW_B = "dddddddd-2222-4ddd-8ddd-dddddddddddd";

  const ctxA = () => ({ userId: fx.userA, schoolId: fx.schoolA, role: "school_admin" as const });

  beforeAll(async () => {
    fx = await seedBaseFixture(sql);
    // 各校に TV 1 台ずつ（BYPASSRLS シード）。行 PK を固定指定し、device_id を FK 先に用意する。
    await sql`
      INSERT INTO tv_devices (id, school_id, device_id, label, version)
      VALUES (${ROW_A}, ${fx.schoolA}, ${DEV_A}, '電子工学科 1年', 1)
    `;
    await sql`
      INSERT INTO tv_devices (id, school_id, device_id, label, version)
      VALUES (${ROW_B}, ${fx.schoolB}, ${DEV_B}, '職員室', 1)
    `;
  });

  beforeEach(async () => {
    await sql`RESET ROLE`;
    await sql`DELETE FROM tv_device_downtime WHERE device_id IN (${DEV_A}, ${DEV_B})`;
  });

  afterAll(async () => {
    await dbSql.end({ timeout: 5 });
    await sql.end({ timeout: 5 });
  });

  // 復帰済みダウンタイム行を BYPASSRLS でシード（時刻は DB 側算出）。
  async function seedResolved(
    schoolId: string,
    deviceId: string,
    wentDownMinutesAgo: number,
    durationSec: number,
  ): Promise<void> {
    await sql`
      INSERT INTO tv_device_downtime (school_id, device_id, went_down_at, recovered_at, duration_sec, cause_hint)
      VALUES (
        ${schoolId}, ${deviceId},
        now() - make_interval(mins => ${wentDownMinutesAgo}::int),
        now() - make_interval(mins => ${wentDownMinutesAgo}::int) + make_interval(secs => ${durationSec}::int),
        ${durationSec}, 'reboot'
      )
    `;
  }

  // 継続中（未復帰）ダウンタイム行を BYPASSRLS でシード。
  async function seedOngoing(
    schoolId: string,
    deviceId: string,
    wentDownMinutesAgo: number,
  ): Promise<void> {
    await sql`
      INSERT INTO tv_device_downtime (school_id, device_id, went_down_at)
      VALUES (${schoolId}, ${deviceId}, now() - make_interval(mins => ${wentDownMinutesAgo}::int))
    `;
  }

  // ---- テナント分離（非 vacuous） ----

  it("school A context は自校 TV のダウンタイム履歴のみ可視（他校 device_id を渡しても 0 件・非 vacuous）", async () => {
    await seedResolved(fx.schoolA, DEV_A, 30, 120);
    await seedResolved(fx.schoolB, DEV_B, 30, 600);

    // 非 vacuity の保証: 他校 (B) のダウンタイム行は BYPASSRLS では確かに存在する。
    const sanity = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM tv_device_downtime WHERE device_id = ${DEV_B}
    `;
    expect(sanity[0].n).toBe("1");

    await withTenantContext(
      db,
      ctxA(),
      async (tx) => {
        // 自校 TV: 1 件見える。
        const own = await listTvDeviceDowntime(tx, DEV_A);
        expect(own.length).toBe(1);
        expect(own[0].deviceId).toBe(DEV_A);

        // 他校 TV の device_id を直接渡しても RLS で 0 件（クロステナント拒否）。
        const cross = await listTvDeviceDowntime(tx, DEV_B);
        expect(cross.length).toBe(0);

        // 稼働サマリも他校は 0 件・0 秒（行が見えない）。
        const crossSummary = await getTvUptimeSummary(tx, DEV_B);
        expect(crossSummary.outageCount).toBe(0);
        expect(crossSummary.totalDowntimeSec).toBe(0);
      },
      APP,
    );
  });

  it("getTvDeviceIdentity: 自校 TV は解決でき、他校 TV は不可視（undefined）", async () => {
    await withTenantContext(
      db,
      ctxA(),
      async (tx) => {
        const own = await getTvDeviceIdentity(tx, ROW_A);
        expect(own?.deviceId).toBe(DEV_A);

        const cross = await getTvDeviceIdentity(tx, ROW_B);
        expect(cross).toBeUndefined();
      },
      APP,
    );
  });

  it("system_admin は cross-tenant で全校のダウンタイム履歴が見える", async () => {
    await seedResolved(fx.schoolA, DEV_A, 30, 120);
    await seedResolved(fx.schoolB, DEV_B, 30, 600);

    await withTenantContext(
      db,
      { role: "system_admin" },
      async (tx) => {
        const a = await listTvDeviceDowntime(tx, DEV_A);
        const b = await listTvDeviceDowntime(tx, DEV_B);
        expect(a.length).toBe(1);
        expect(b.length).toBe(1);
      },
      APP,
    );
  });

  // ---- 決定的順序 ----

  it("listTvDeviceDowntime: 新しい順（desc went_down_at）+ 同時刻 tie は id で決定化", async () => {
    // 3 件: 5 分前 / 10 分前 / 10 分前（同時刻 tie 2 件）。新しい順 + id desc tiebreak で安定。
    await seedResolved(fx.schoolA, DEV_A, 5, 30);
    await seedOngoing(fx.schoolA, DEV_A, 10);
    await seedOngoing(fx.schoolA, DEV_A, 10);

    await withTenantContext(
      db,
      ctxA(),
      async (tx) => {
        const rows = await listTvDeviceDowntime(tx, DEV_A);
        expect(rows.length).toBe(3);
        // 先頭は最も新しい（5 分前）。
        const first = rows[0];
        const tail = rows.slice(1);
        expect(first.wentDownAt.getTime()).toBeGreaterThan(tail[0].wentDownAt.getTime());
        // 残り 2 件は同時刻。went_down_at は等しく、id 降順で安定（決定的順序）。
        expect(tail[0].wentDownAt.getTime()).toBe(tail[1].wentDownAt.getTime());
        expect(tail[0].id > tail[1].id).toBe(true);
        // 2 回実行しても同じ順序（決定性）。
        const again = await listTvDeviceDowntime(tx, DEV_A);
        expect(again.map((r) => r.id)).toEqual(rows.map((r) => r.id));
      },
      APP,
    );
  });

  it("listTvDeviceDowntime: limit が効く", async () => {
    await seedResolved(fx.schoolA, DEV_A, 5, 30);
    await seedResolved(fx.schoolA, DEV_A, 10, 30);
    await seedResolved(fx.schoolA, DEV_A, 15, 30);

    await withTenantContext(
      db,
      ctxA(),
      async (tx) => {
        const rows = await listTvDeviceDowntime(tx, DEV_A, 2);
        expect(rows.length).toBe(2);
      },
      APP,
    );
  });

  // ---- 稼働サマリ集計 ----

  it("getTvUptimeSummary: 復帰済み duration_sec を合算 + 件数（DB now() 基準窓）", async () => {
    await seedResolved(fx.schoolA, DEV_A, 30, 120);
    await seedResolved(fx.schoolA, DEV_A, 60, 300);

    await withTenantContext(
      db,
      ctxA(),
      async (tx) => {
        const summary = await getTvUptimeSummary(tx, DEV_A);
        expect(summary.deviceId).toBe(DEV_A);
        expect(summary.windowDays).toBe(7);
        expect(summary.outageCount).toBe(2);
        // 復帰済み 2 件の duration を合算（120 + 300 = 420）。
        expect(summary.totalDowntimeSec).toBe(420);
      },
      APP,
    );
  });

  it("getTvUptimeSummary: 継続中アウテージは now()-went_down_at を計上（取りこぼさない）", async () => {
    // 10 分前にダウンしたまま継続中（recovered_at NULL）→ およそ 600 秒を計上。
    await seedOngoing(fx.schoolA, DEV_A, 10);

    await withTenantContext(
      db,
      ctxA(),
      async (tx) => {
        const summary = await getTvUptimeSummary(tx, DEV_A);
        expect(summary.outageCount).toBe(1);
        // 10 分 ≒ 600 秒（実行誤差を見て 570〜660 で許容）。
        expect(summary.totalDowntimeSec).toBeGreaterThanOrEqual(570);
        expect(summary.totalDowntimeSec).toBeLessThanOrEqual(660);
      },
      APP,
    );
  });

  it("getTvUptimeSummary: 窓外（古い）アウテージは集計に含めない（DB now() 基準窓）", async () => {
    // 窓 1 日に対し 2 日前（=窓外）のアウテージ。
    await seedResolved(fx.schoolA, DEV_A, 60 * 24 * 2, 100);

    await withTenantContext(
      db,
      ctxA(),
      async (tx) => {
        const summary = await getTvUptimeSummary(tx, DEV_A, 1);
        expect(summary.windowDays).toBe(1);
        expect(summary.outageCount).toBe(0);
        expect(summary.totalDowntimeSec).toBe(0);
      },
      APP,
    );
  });

  it("getTvUptimeSummary: アウテージ 0 件なら 0 を返す（COALESCE）", async () => {
    await withTenantContext(
      db,
      ctxA(),
      async (tx) => {
        const summary = await getTvUptimeSummary(tx, DEV_A);
        expect(summary.outageCount).toBe(0);
        expect(summary.totalDowntimeSec).toBe(0);
      },
      APP,
    );
  });
});
