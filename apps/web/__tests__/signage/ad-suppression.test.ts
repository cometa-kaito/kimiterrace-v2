import { describe, expect, it } from "vitest";
import {
  type AdSuppressionConfig,
  DEFAULT_AD_SUPPRESSION_WEEKDAYS,
  MAX_AD_SUPPRESSION_RANGES,
  isAdSuppressedAt,
  isSuppressedAtMinutes,
  jstWeekdayAndMinutes,
  parseAdSuppression,
  validateAdSuppression,
} from "@/lib/signage/ad-suppression";

/**
 * 授業時間中の広告停止（`school_configs` の学校スコープ `display_settings.value.adSuppression`）の純ロジック
 * 単体テスト（DB 非依存）。配信層（`buildSignagePayloadForClass` が `now` 指定時に広告を空にする）と設定 UI /
 * Server Action（`validateAdSuppression`）が共有する parse / 判定 / 検証を固定する。
 *
 * fail-soft の向き: 読み取り失敗・壊れた値・enabled=false・時間帯 0 件・対象曜日外は **停止しない（＝広告を出す）**。
 */

describe("parseAdSuppression（display_settings.adSuppression の defensive 解決）", () => {
  it("正常な値をそのまま復元する", () => {
    const cfg = parseAdSuppression({
      adSuppression: {
        enabled: true,
        ranges: [{ start: "08:50", end: "09:40" }],
        weekdays: [1, 2, 3, 4, 5],
      },
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.ranges).toEqual([{ start: "08:50", end: "09:40" }]);
    expect(cfg.weekdays).toEqual([1, 2, 3, 4, 5]);
  });

  it("キー欠落・空オブジェクトは既定（enabled=false・停止しない）", () => {
    expect(parseAdSuppression({})).toEqual({
      enabled: false,
      ranges: [],
      weekdays: [...DEFAULT_AD_SUPPRESSION_WEEKDAYS],
    });
    // 相乗りする別キーだけがある行でも adSuppression が無ければ既定。
    expect(parseAdSuppression({ signageDesign: "pattern2" }).enabled).toBe(false);
  });

  it("null / 非オブジェクト / 配列は既定に倒す", () => {
    for (const v of [null, undefined, "x", 123, true, [{ adSuppression: { enabled: true } }]]) {
      expect(parseAdSuppression(v).enabled).toBe(false);
    }
  });

  it("壊れた range 要素は落とし、正しい要素だけ残す", () => {
    const cfg = parseAdSuppression({
      adSuppression: {
        enabled: true,
        ranges: [
          { start: "08:50", end: "09:40" },
          { start: "bad", end: "10:00" },
          { start: "10:50" }, // end 欠落
          null,
          { start: "13:00", end: "13:50" },
        ],
      },
    });
    expect(cfg.ranges).toEqual([
      { start: "08:50", end: "09:40" },
      { start: "13:00", end: "13:50" },
    ]);
  });

  it("weekdays が非配列なら既定（月〜金）、壊れた要素は無視", () => {
    expect(parseAdSuppression({ adSuppression: { weekdays: "bad" } }).weekdays).toEqual([
      ...DEFAULT_AD_SUPPRESSION_WEEKDAYS,
    ]);
    expect(
      parseAdSuppression({ adSuppression: { weekdays: [1, 7, -1, 2, 2, 3.5] } }).weekdays,
    ).toEqual([1, 2]);
  });
});

describe("isSuppressedAtMinutes（JST 曜日・分からの停止判定・純関数）", () => {
  const base: AdSuppressionConfig = {
    enabled: true,
    ranges: [
      { start: "08:50", end: "09:40" },
      { start: "13:00", end: "13:50" },
    ],
    weekdays: [1, 2, 3, 4, 5],
  };

  it("時間帯内は停止する", () => {
    expect(isSuppressedAtMinutes(base, 1, 8 * 60 + 50)).toBe(true); // 開始ちょうど（境界内）
    expect(isSuppressedAtMinutes(base, 3, 9 * 60 + 0)).toBe(true);
    expect(isSuppressedAtMinutes(base, 5, 13 * 60 + 49)).toBe(true);
  });

  it("終了時刻ちょうどは停止しない（[start, end) 半開区間）", () => {
    expect(isSuppressedAtMinutes(base, 1, 9 * 60 + 40)).toBe(false);
  });

  it("時間帯外（休み時間）は停止しない", () => {
    expect(isSuppressedAtMinutes(base, 1, 9 * 60 + 45)).toBe(false); // 1限後の休み時間
    expect(isSuppressedAtMinutes(base, 1, 7 * 60 + 0)).toBe(false); // 始業前
  });

  it("対象曜日でなければ停止しない（土日など）", () => {
    expect(isSuppressedAtMinutes(base, 0, 9 * 60)).toBe(false); // 日曜
    expect(isSuppressedAtMinutes(base, 6, 9 * 60)).toBe(false); // 土曜
  });

  it("enabled=false は常に停止しない", () => {
    expect(isSuppressedAtMinutes({ ...base, enabled: false }, 1, 9 * 60)).toBe(false);
  });

  it("時間帯 0 件は常に停止しない", () => {
    expect(isSuppressedAtMinutes({ ...base, ranges: [] }, 1, 9 * 60)).toBe(false);
  });

  it("対象曜日が空配列なら（全曜日オフ）常に停止しない", () => {
    expect(isSuppressedAtMinutes({ ...base, weekdays: [] }, 1, 9 * 60)).toBe(false);
  });
});

describe("jstWeekdayAndMinutes（絶対時刻→JST 曜日・分）", () => {
  it("UTC を JST(+9h) に換算する", () => {
    // 2026-07-13(月) 00:50 UTC = 2026-07-13(月) 09:50 JST
    const { weekday, minutes } = jstWeekdayAndMinutes(new Date("2026-07-13T00:50:00Z"));
    expect(weekday).toBe(1); // 月
    expect(minutes).toBe(9 * 60 + 50);
  });

  it("日付が JST で繰り上がるケース（UTC 夜→JST 翌朝）", () => {
    // 2026-07-12(日) 23:00 UTC = 2026-07-13(月) 08:00 JST
    const { weekday, minutes } = jstWeekdayAndMinutes(new Date("2026-07-12T23:00:00Z"));
    expect(weekday).toBe(1); // 月
    expect(minutes).toBe(8 * 60);
  });
});

describe("isAdSuppressedAt（now 起点の統合判定）", () => {
  const cfg: AdSuppressionConfig = {
    enabled: true,
    ranges: [{ start: "08:50", end: "09:40" }],
    weekdays: [1, 2, 3, 4, 5],
  };

  it("平日の授業時間中（JST）は停止する", () => {
    // 2026-07-13(月) 00:00 UTC = 09:00 JST（1限中）
    expect(isAdSuppressedAt(cfg, new Date("2026-07-13T00:00:00Z"))).toBe(true);
  });

  it("土曜の同時刻は停止しない", () => {
    // 2026-07-11(土) 00:00 UTC = 09:00 JST
    expect(isAdSuppressedAt(cfg, new Date("2026-07-11T00:00:00Z"))).toBe(false);
  });
});

describe("validateAdSuppression（Server Action 入力検証）", () => {
  it("正常入力を正規化して返す（重なり無し・start 昇順）", () => {
    const res = validateAdSuppression(
      true,
      [
        { start: "13:00", end: "13:50" },
        { start: "08:50", end: "09:40" },
      ],
      [5, 1, 3],
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.enabled).toBe(true);
      expect(res.value.ranges).toEqual([
        { start: "08:50", end: "09:40" },
        { start: "13:00", end: "13:50" },
      ]);
      expect(res.value.weekdays).toEqual([1, 3, 5]);
    }
  });

  it("enabled=false + 空時間帯は許可（停止なしに更新できる）", () => {
    const res = validateAdSuppression(false, [], [1, 2, 3, 4, 5]);
    expect(res.ok).toBe(true);
  });

  it("HH:MM 不正・start>=end・重なり・件数超過・非 boolean を拒否する", () => {
    expect(validateAdSuppression("yes", [], []).ok).toBe(false); // enabled 非 boolean
    expect(validateAdSuppression(true, [{ start: "25:00", end: "26:00" }], []).ok).toBe(false);
    expect(validateAdSuppression(true, [{ start: "10:00", end: "09:00" }], []).ok).toBe(false);
    expect(
      validateAdSuppression(
        true,
        [
          { start: "08:50", end: "09:40" },
          { start: "09:30", end: "10:20" }, // 重なり
        ],
        [],
      ).ok,
    ).toBe(false);
    const tooMany = Array.from({ length: MAX_AD_SUPPRESSION_RANGES + 1 }, (_, i) => ({
      start: `${String(i).padStart(2, "0")}:00`,
      end: `${String(i).padStart(2, "0")}:30`,
    }));
    expect(validateAdSuppression(true, tooMany, []).ok).toBe(false);
    expect(validateAdSuppression(true, [], [7]).ok).toBe(false); // 曜日 0..6 外
  });
});
