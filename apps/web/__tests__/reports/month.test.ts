import { describe, expect, it } from "vitest";
import {
  currentJstYearMonth,
  formatYearMonth,
  isAfterMonth,
  isSameMonth,
  parseYearMonth,
  shiftMonth,
  toYmParam,
} from "../../lib/reports/month";

/**
 * F09 (#45): 月次レポートの月演算ユーティリティの単体テスト。純粋関数なので DB 不要。
 * JST 月境界・繰り上げ/繰り下げ・`?ym` パースの厳格性を検証する。
 */
describe("F09 month utils", () => {
  describe("currentJstYearMonth", () => {
    it("UTC 月末深夜は JST では翌月になる (UTC+9 の壁時計で読む)", () => {
      // 2026-06-30 23:00 UTC = 2026-07-01 08:00 JST → 7 月
      expect(currentJstYearMonth(new Date("2026-06-30T23:00:00Z"))).toEqual({
        year: 2026,
        month: 7,
      });
      // 2026-06-30 12:00 UTC = 2026-06-30 21:00 JST → 6 月
      expect(currentJstYearMonth(new Date("2026-06-30T12:00:00Z"))).toEqual({
        year: 2026,
        month: 6,
      });
      // 年跨ぎ: 2026-12-31 20:00 UTC = 2027-01-01 05:00 JST → 2027 年 1 月
      expect(currentJstYearMonth(new Date("2026-12-31T20:00:00Z"))).toEqual({
        year: 2027,
        month: 1,
      });
    });
  });

  describe("parseYearMonth", () => {
    it("YYYY-MM を厳格にパースする", () => {
      expect(parseYearMonth("2026-06")).toEqual({ year: 2026, month: 6 });
      expect(parseYearMonth("2026-12")).toEqual({ year: 2026, month: 12 });
    });
    it("不正・範囲外・未指定は null", () => {
      expect(parseYearMonth(undefined)).toBeNull();
      expect(parseYearMonth("")).toBeNull();
      expect(parseYearMonth("2026-13")).toBeNull();
      expect(parseYearMonth("2026-00")).toBeNull();
      expect(parseYearMonth("2026-6")).toBeNull(); // ゼロ埋め必須
      expect(parseYearMonth("26-06")).toBeNull();
      expect(parseYearMonth("2026/06")).toBeNull();
      expect(parseYearMonth("abc")).toBeNull();
    });
  });

  describe("toYmParam / formatYearMonth", () => {
    it("ゼロ埋め YYYY-MM と日本語表示を返す", () => {
      expect(toYmParam({ year: 2026, month: 6 })).toBe("2026-06");
      expect(toYmParam({ year: 2026, month: 12 })).toBe("2026-12");
      expect(formatYearMonth({ year: 2026, month: 6 })).toBe("2026年6月");
    });
  });

  describe("shiftMonth", () => {
    it("月内のずらし", () => {
      expect(shiftMonth({ year: 2026, month: 6 }, -1)).toEqual({ year: 2026, month: 5 });
      expect(shiftMonth({ year: 2026, month: 6 }, +1)).toEqual({ year: 2026, month: 7 });
    });
    it("年の繰り上げ/繰り下げを伝播する", () => {
      expect(shiftMonth({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 });
      expect(shiftMonth({ year: 2026, month: 12 }, +1)).toEqual({ year: 2027, month: 1 });
      expect(shiftMonth({ year: 2026, month: 6 }, -18)).toEqual({ year: 2024, month: 12 });
    });
  });

  describe("isAfterMonth / isSameMonth", () => {
    it("年→月の辞書順で比較する", () => {
      expect(isAfterMonth({ year: 2026, month: 7 }, { year: 2026, month: 6 })).toBe(true);
      expect(isAfterMonth({ year: 2027, month: 1 }, { year: 2026, month: 12 })).toBe(true);
      expect(isAfterMonth({ year: 2026, month: 6 }, { year: 2026, month: 6 })).toBe(false);
      expect(isAfterMonth({ year: 2026, month: 5 }, { year: 2026, month: 6 })).toBe(false);
      expect(isSameMonth({ year: 2026, month: 6 }, { year: 2026, month: 6 })).toBe(true);
      expect(isSameMonth({ year: 2026, month: 6 }, { year: 2026, month: 7 })).toBe(false);
    });
  });
});
