import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, withTenantContext } from "../../src/client.js";
import { getPresenceQuarterHourHeatmap } from "../../src/queries/event-stats.js";
import { getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

/**
 * F08 (#44): 人感ヒートマップ read 層 getPresenceQuarterHourHeatmap を実 PG (RLS 込み) で検証する。
 *
 * 観点: (1) `events.type='presence'` のみを **15 分バケット (0-95) × 平日/休日**で集計し view/tap を
 * 除外、(2) バケット算出が JST かつ 15 分丸め (時*4 + 分/15)、(3) 曜日区分が JST dow で土日=weekend /
 * 月〜金=weekday、(4) 期間窓 (sinceDays) が DB now() 基準で効く、(5) **テナント分離** — 別校が漏れない
 * (CLAUDE.md ルール2)、(6) 空コンテキストは deny-by-default で 0 件。
 *
 * occurred_at は JS Date を bind せず DB 側で構築する ([[pg-date-bind-enum-insert]]: postgres@3.4.9 は
 * enum 列を含む INSERT で timestamptz の Date を直列化できない)。曜日依存テストは実行日の曜日に
 * 左右されないよう、目的の dow まで「何日前か」を SQL で算出して seed する。DATABASE_URL 未設定なら
 * ローカルは skip、CI (実 PG16) で実行。
 */

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

describeOrSkip(
  "F08 getPresenceQuarterHourHeatmap (人感ヒートマップ read、15分×平日/休日 + RLS)",
  () => {
    // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
    const { sql: raw, db } = createDbClient(url!);
    const APP = { appRole: "kimiterrace_app" };
    let fx: Awaited<ReturnType<typeof seedBaseFixture>>;

    const ctxA = () => ({ schoolId: fx.schoolA, role: "school_admin" as const });
    const ctxB = () => ({ schoolId: fx.schoolB, role: "school_admin" as const });

    // 「直近の指定 dow (0=日..6=土) の JST 暦日」の jstHour:jstMinute に event を投入する。
    // 何日前がその曜日かを SQL で算出する: (((cur_dow - dow + 6) % 7) + 1) = 1〜7 日前。常に過去 7 日内へ
    // land するため既定 30 日窓に収まり、occurred_at は厳密に過去になる (窓に未来上限が無くても安全)。
    // 実行日の曜日に依らず weekday/weekend を決定的に作れる ([[pg-date-bind-enum-insert]])。
    async function seedAtDow(
      schoolId: string,
      type: "view" | "tap" | "presence",
      dow: number,
      jstHour: number,
      jstMinute: number,
    ): Promise<void> {
      await raw`
      INSERT INTO events (school_id, type, occurred_at)
      VALUES (
        ${schoolId}, ${type},
        (
          date_trunc('day', now() at time zone 'Asia/Tokyo')
            - make_interval(days =>
                (((extract(dow from now() at time zone 'Asia/Tokyo')::int - ${dow}::int + 6) % 7) + 1))
            + make_interval(hours => ${jstHour}::int, mins => ${jstMinute}::int)
        ) at time zone 'Asia/Tokyo'
      )
    `;
    }

    // 期間窓テスト用: ${daysAgo} 日前に投入 (バケット/曜日は now() の値、窓の内外判定にのみ使う)。
    async function seedDaysAgo(
      schoolId: string,
      type: "view" | "tap" | "presence",
      daysAgo: number,
    ): Promise<void> {
      await raw`
      INSERT INTO events (school_id, type, occurred_at)
      VALUES (${schoolId}, ${type}, now() - make_interval(days => ${daysAgo}::int))
    `;
    }

    beforeAll(async () => {
      fx = await seedBaseFixture(raw);
    });

    beforeEach(async () => {
      await raw`RESET ROLE`;
      await raw`DELETE FROM events`;
    });

    afterAll(async () => {
      await raw.end({ timeout: 5 });
    });

    it("presence のみを 15 分バケット × 平日/休日で集計し dayType→bucket 昇順で返す (view/tap 除外)", async () => {
      // 平日(月) 08:00 → bucket 32 ×2、平日(月) 08:15 → bucket 33 ×1、休日(土) 13:30 → bucket 54 ×1。
      await seedAtDow(fx.schoolA, "presence", 1, 8, 0);
      await seedAtDow(fx.schoolA, "presence", 1, 8, 0);
      await seedAtDow(fx.schoolA, "presence", 1, 8, 15);
      await seedAtDow(fx.schoolA, "presence", 6, 13, 30);
      // 同バケットの view/tap は presence 集計に混ざらないこと。
      await seedAtDow(fx.schoolA, "view", 1, 8, 0);
      await seedAtDow(fx.schoolA, "tap", 6, 13, 30);

      const rows = await withTenantContext(
        db,
        ctxA(),
        (tx) => getPresenceQuarterHourHeatmap(tx),
        APP,
      );
      expect(rows).toEqual([
        { dayType: "weekday", bucket: 32, presence: 2 },
        { dayType: "weekday", bucket: 33, presence: 1 },
        { dayType: "weekend", bucket: 54, presence: 1 },
      ]);
    });

    it("15 分丸め: 同一 15 分窓内の分は同じ bucket、境界 (:15) で次の bucket に進む", async () => {
      // 08:07 と 08:14 はどちらも bucket 32 (= 8*4 + floor(分/15))、08:15 は bucket 33。
      await seedAtDow(fx.schoolA, "presence", 2, 8, 7);
      await seedAtDow(fx.schoolA, "presence", 2, 8, 14);
      await seedAtDow(fx.schoolA, "presence", 2, 8, 15);

      const rows = await withTenantContext(
        db,
        ctxA(),
        (tx) => getPresenceQuarterHourHeatmap(tx),
        APP,
      );
      expect(rows).toEqual([
        { dayType: "weekday", bucket: 32, presence: 2 },
        { dayType: "weekday", bucket: 33, presence: 1 },
      ]);
    });

    it("曜日区分: 土日は weekend、月〜金は weekday (同一 bucket でも別行)", async () => {
      // 月(平日) と 日(休日) の同じ 10:00 (bucket 40) を別 dayType として 2 行に分ける。
      await seedAtDow(fx.schoolA, "presence", 1, 10, 0); // 月 = weekday
      await seedAtDow(fx.schoolA, "presence", 0, 10, 0); // 日 = weekend

      const rows = await withTenantContext(
        db,
        ctxA(),
        (tx) => getPresenceQuarterHourHeatmap(tx),
        APP,
      );
      expect(rows).toEqual([
        { dayType: "weekday", bucket: 40, presence: 1 },
        { dayType: "weekend", bucket: 40, presence: 1 },
      ]);
    });

    it("テナント分離: 別校の presence はヒートマップに漏れない (RLS)", async () => {
      await seedAtDow(fx.schoolA, "presence", 1, 9, 0); // bucket 36
      await seedAtDow(fx.schoolB, "presence", 1, 9, 0);
      await seedAtDow(fx.schoolB, "presence", 1, 9, 0);

      const a = await withTenantContext(db, ctxA(), (tx) => getPresenceQuarterHourHeatmap(tx), APP);
      expect(a).toEqual([{ dayType: "weekday", bucket: 36, presence: 1 }]);

      const b = await withTenantContext(db, ctxB(), (tx) => getPresenceQuarterHourHeatmap(tx), APP);
      expect(b).toEqual([{ dayType: "weekday", bucket: 36, presence: 2 }]);
    });

    it("sinceDays 窓外の presence は含めない (DB now() 基準)", async () => {
      await seedDaysAgo(fx.schoolA, "presence", 1); // 窓内
      await seedDaysAgo(fx.schoolA, "presence", 40); // 既定 30 日窓外

      const def = await withTenantContext(
        db,
        ctxA(),
        (tx) => getPresenceQuarterHourHeatmap(tx),
        APP,
      );
      expect(def.reduce((s, r) => s + r.presence, 0)).toBe(1);

      const wide = await withTenantContext(
        db,
        ctxA(),
        (tx) => getPresenceQuarterHourHeatmap(tx, { sinceDays: 90 }),
        APP,
      );
      expect(wide.reduce((s, r) => s + r.presence, 0)).toBe(2);
    });

    it("deny-by-default: 空コンテキストは 0 件", async () => {
      await seedAtDow(fx.schoolA, "presence", 1, 8, 0);
      const rows = await withTenantContext(db, {}, (tx) => getPresenceQuarterHourHeatmap(tx), APP);
      expect(rows).toEqual([]);
    });
  },
);
