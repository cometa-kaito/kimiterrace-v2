import { describe, expect, it } from "vitest";
import type { HourlyPresenceCount } from "@kimiterrace/db";
import { densifyPresenceHourly, hasPresenceData } from "../../lib/dashboard/presence";

/**
 * F08 (#44): 効果ダッシュボードの時間帯別 在室 (presence) 表示ヘルパーの単体テスト。
 * 純粋関数なので DB 不要。0〜23 時の密化・空判定の正当性を検証する。
 */
describe("F08 dashboard presence helpers", () => {
  describe("densifyPresenceHourly", () => {
    it("0〜23 時を必ず網羅した 24 要素 (時昇順) を返す", () => {
      const dense = densifyPresenceHourly([]);
      expect(dense).toHaveLength(24);
      expect(dense.map((h) => h.hour)).toEqual(Array.from({ length: 24 }, (_, i) => i));
      // すべて 0 埋め
      expect(dense.every((h) => h.presence === 0)).toBe(true);
    });

    it("存在する時はそのまま、欠けた時は 0 で埋める", () => {
      const sparse: HourlyPresenceCount[] = [
        { hour: 8, presence: 12 },
        { hour: 13, presence: 5 },
      ];
      const dense = densifyPresenceHourly(sparse);
      expect(dense[8]).toEqual({ hour: 8, presence: 12 });
      expect(dense[13]).toEqual({ hour: 13, presence: 5 });
      // 埋められた時は 0
      expect(dense[0]).toEqual({ hour: 0, presence: 0 });
      expect(dense[23]).toEqual({ hour: 23, presence: 0 });
      // 件数の総和は元データと一致 (取りこぼし・二重計上なし)
      expect(dense.reduce((s, h) => s + h.presence, 0)).toBe(17);
    });

    it("0-23 の範囲外/非整数の hour は防御的に捨てる", () => {
      const bad: HourlyPresenceCount[] = [
        { hour: -1, presence: 9 },
        { hour: 24, presence: 9 },
        { hour: 9.5, presence: 9 },
        { hour: 9, presence: 3 },
      ];
      const dense = densifyPresenceHourly(bad);
      expect(dense).toHaveLength(24);
      expect(dense[9]).toEqual({ hour: 9, presence: 3 });
      // 範囲外を取り込んでいないので総和は hour=9 の分だけ
      expect(dense.reduce((s, h) => s + h.presence, 0)).toBe(3);
    });
  });

  describe("hasPresenceData", () => {
    it("presence が 1 件でもあれば true", () => {
      expect(hasPresenceData([{ hour: 7, presence: 1 }])).toBe(true);
    });
    it("空配列・全 0 は false", () => {
      expect(hasPresenceData([])).toBe(false);
      expect(hasPresenceData([{ hour: 7, presence: 0 }])).toBe(false);
    });
  });
});
