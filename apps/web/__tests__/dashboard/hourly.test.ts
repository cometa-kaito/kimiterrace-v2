import { describe, expect, it } from "vitest";
import type { HourlyEventCount } from "@kimiterrace/db";
import { densifyHourly, formatHour, hasHourlyData } from "../../lib/dashboard/hourly";

/**
 * F08 (#44): 効果ダッシュボードの時間帯別 (JST hour-of-day) 表示ヘルパーの単体テスト。
 * 純粋関数なので DB 不要。0〜23 時の密化・空判定・整形の正当性を検証する。
 */
describe("F08 dashboard hourly helpers", () => {
  describe("densifyHourly", () => {
    it("0〜23 時を必ず網羅した 24 要素 (時昇順) を返す", () => {
      const dense = densifyHourly([]);
      expect(dense).toHaveLength(24);
      expect(dense.map((h) => h.hour)).toEqual(Array.from({ length: 24 }, (_, i) => i));
      // すべて 0 埋め
      expect(dense.every((h) => h.views === 0 && h.taps === 0)).toBe(true);
    });

    it("存在する時はそのまま、欠けた時は 0 で埋める", () => {
      const sparse: HourlyEventCount[] = [
        { hour: 8, views: 5, taps: 2 },
        { hour: 12, views: 3, taps: 0 },
      ];
      const dense = densifyHourly(sparse);
      expect(dense[8]).toEqual({ hour: 8, views: 5, taps: 2 });
      expect(dense[12]).toEqual({ hour: 12, views: 3, taps: 0 });
      // 埋められた時は 0
      expect(dense[0]).toEqual({ hour: 0, views: 0, taps: 0 });
      expect(dense[23]).toEqual({ hour: 23, views: 0, taps: 0 });
      // 件数の総和は元データと一致 (取りこぼし・二重計上なし)
      const sumViews = dense.reduce((s, h) => s + h.views, 0);
      expect(sumViews).toBe(8);
    });

    it("0-23 の範囲外/非整数の hour は防御的に捨てる", () => {
      const bad: HourlyEventCount[] = [
        { hour: -1, views: 9, taps: 9 },
        { hour: 24, views: 9, taps: 9 },
        { hour: 9.5, views: 9, taps: 9 },
        { hour: 9, views: 1, taps: 1 },
      ];
      const dense = densifyHourly(bad);
      expect(dense).toHaveLength(24);
      expect(dense[9]).toEqual({ hour: 9, views: 1, taps: 1 });
      // 範囲外を取り込んでいないので総和は hour=9 の分だけ
      expect(dense.reduce((s, h) => s + h.views + h.taps, 0)).toBe(2);
    });
  });

  describe("hasHourlyData", () => {
    it("view/tap が 1 件でもあれば true", () => {
      expect(hasHourlyData([{ hour: 7, views: 0, taps: 1 }])).toBe(true);
      expect(hasHourlyData([{ hour: 7, views: 2, taps: 0 }])).toBe(true);
    });
    it("空配列・全 0 は false", () => {
      expect(hasHourlyData([])).toBe(false);
      expect(hasHourlyData([{ hour: 7, views: 0, taps: 0 }])).toBe(false);
    });
  });

  describe("formatHour", () => {
    it("JST の時を 'N時' に整形する", () => {
      expect(formatHour(0)).toBe("0時");
      expect(formatHour(9)).toBe("9時");
      expect(formatHour(23)).toBe("23時");
    });
  });
});
