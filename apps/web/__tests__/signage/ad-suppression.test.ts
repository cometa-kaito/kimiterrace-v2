import { describe, expect, it } from "vitest";
import {
  type AdSuppressionConfig,
  MAX_AD_SUPPRESSION_VARIATIONS,
  NONE_VARIATION_KEY,
  isAdSuppressedAt,
  isSuppressedAtParts,
  isValidDateStr,
  jstDateParts,
  parseAdSuppression,
  resolveVariationRanges,
  validateAdSuppression,
} from "@/lib/signage/ad-suppression";

/**
 * 授業時間中の広告停止（`display_settings.adSuppression`）v2 モデル（時間割バリエーション + 年間割り当て）の
 * 純ロジック単体テスト（DB 非依存）。配信層（`buildSignagePayloadForClass` が `now` 指定時に広告を空にする）と
 * 設定 UI / Server Action（`validateAdSuppression`）が共有する parse / 解決 / 判定 / 検証を固定する。
 *
 * fail-soft の向き: 読み取り失敗・壊れた値・enabled=false・割り当て無し・NONE・幽霊 key 参照は **停止しない**。
 */

const NORMAL = { key: "k-normal", name: "通常時間割", ranges: [{ start: "08:50", end: "09:40" }] };
const SHORT = { key: "k-short", name: "短縮時間割", ranges: [{ start: "08:50", end: "09:20" }] };

function cfg(over: Partial<AdSuppressionConfig> = {}): AdSuppressionConfig {
  return {
    enabled: true,
    variations: [NORMAL, SHORT],
    weekdayMap: { 1: "k-normal", 3: "k-short", 6: NONE_VARIATION_KEY },
    overrides: {},
    ...over,
  };
}

describe("parseAdSuppression（defensive 解決）", () => {
  it("v2 形式（variations + weekdayMap + overrides）を復元する", () => {
    const c = parseAdSuppression({
      adSuppression: {
        enabled: true,
        variations: [NORMAL, SHORT],
        weekdayMap: { 1: "k-normal", 3: "k-short" },
        overrides: { "2026-09-30": "k-short" },
      },
    });
    expect(c.enabled).toBe(true);
    expect(c.variations).toHaveLength(2);
    expect(c.weekdayMap).toEqual({ 1: "k-normal", 3: "k-short" });
    expect(c.overrides).toEqual({ "2026-09-30": "k-short" });
  });

  it("v1 旧形式（ranges + weekdays）を『通常時間割』1 バリエーションへ移行する", () => {
    const c = parseAdSuppression({
      adSuppression: {
        enabled: true,
        ranges: [{ start: "08:50", end: "09:40" }],
        weekdays: [1, 2, 3, 4, 5],
      },
    });
    expect(c.variations).toHaveLength(1);
    expect(c.variations[0]?.name).toBe("通常時間割");
    expect(c.variations[0]?.ranges).toEqual([{ start: "08:50", end: "09:40" }]);
    // weekdays が weekdayMap へ移行され、その key を指す。
    expect(c.weekdayMap[1]).toBe(c.variations[0]?.key);
    expect(Object.keys(c.weekdayMap)).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("v1 で ranges が空なら variation を作らず weekdayMap も張らない（幽霊 key を残さない）", () => {
    const c = parseAdSuppression({
      adSuppression: { enabled: true, ranges: [], weekdays: [1, 2, 3] },
    });
    expect(c.variations).toEqual([]);
    expect(c.weekdayMap).toEqual({});
  });

  it("幽霊 key 参照（存在しないバリエーション）を割り当てから落とす", () => {
    const c = parseAdSuppression({
      adSuppression: {
        enabled: true,
        variations: [NORMAL],
        weekdayMap: { 1: "k-normal", 2: "ghost" },
        overrides: { "2026-09-30": "ghost", "2026-10-01": NONE_VARIATION_KEY },
      },
    });
    expect(c.weekdayMap).toEqual({ 1: "k-normal" }); // ghost 落ちる
    expect(c.overrides).toEqual({ "2026-10-01": NONE_VARIATION_KEY }); // ghost 落ち、NONE は残る
  });

  it("壊れた range/日付を落とす", () => {
    const c = parseAdSuppression({
      adSuppression: {
        variations: [{ key: "k", name: "x", ranges: [{ start: "bad", end: "09:00" }] }],
        overrides: { "2026-02-30": "k", "bad-date": "k", "2026-09-30": "k" },
      },
    });
    expect(c.variations[0]?.ranges).toEqual([]);
    expect(c.overrides).toEqual({ "2026-09-30": "k" }); // 実在日付だけ
  });

  it("null / 非オブジェクト / キー欠落は空設定（停止しない）", () => {
    for (const v of [null, undefined, "x", 123, [], {}, { adSuppression: 5 }]) {
      const c = parseAdSuppression(v);
      expect(c.enabled).toBe(false);
      expect(c.variations).toEqual([]);
    }
  });
});

describe("isValidDateStr", () => {
  it("実在日付だけ true", () => {
    expect(isValidDateStr("2026-09-30")).toBe(true);
    expect(isValidDateStr("2026-02-30")).toBe(false); // 2月30日は無い
    expect(isValidDateStr("2026-13-01")).toBe(false);
    expect(isValidDateStr("2026/09/30")).toBe(false);
    expect(isValidDateStr("bad")).toBe(false);
  });
});

describe("resolveVariationRanges（優先順位）", () => {
  it("特定日上書きが曜日既定より優先する", () => {
    // 2026-07-13 は月曜(1)。曜日既定=k-normal、上書き=k-short → 上書きが勝つ。
    const c = cfg({ weekdayMap: { 1: "k-normal" }, overrides: { "2026-07-13": "k-short" } });
    expect(resolveVariationRanges(c, "2026-07-13", 1)).toEqual(SHORT.ranges);
  });

  it("曜日既定を使う（上書き無し）", () => {
    expect(resolveVariationRanges(cfg(), "2026-07-13", 1)).toEqual(NORMAL.ranges);
    expect(resolveVariationRanges(cfg(), "2026-07-15", 3)).toEqual(SHORT.ranges);
  });

  it("NONE / 割り当て無し / 幽霊 key は null（停止しない）", () => {
    expect(resolveVariationRanges(cfg(), "2026-07-18", 6)).toBeNull(); // 土=NONE
    expect(resolveVariationRanges(cfg(), "2026-07-14", 2)).toBeNull(); // 火=未割当
    const ghost = cfg({ weekdayMap: { 1: "ghost" } });
    expect(resolveVariationRanges(ghost, "2026-07-13", 1)).toBeNull();
  });
});

describe("isSuppressedAtParts（時刻判定）", () => {
  it("割り当てられた時間帯内は停止する", () => {
    expect(isSuppressedAtParts(cfg(), "2026-07-13", 1, 9 * 60)).toBe(true); // 月 09:00 通常
    expect(isSuppressedAtParts(cfg(), "2026-07-15", 3, 9 * 60 + 10)).toBe(true); // 水 09:10 短縮内
  });
  it("短縮では枠外なら止めない（通常なら枠内でも短縮が適用）", () => {
    // 水=短縮(08:50-09:20)。09:30 は短縮では枠外 → 止めない。
    expect(isSuppressedAtParts(cfg(), "2026-07-15", 3, 9 * 60 + 30)).toBe(false);
  });
  it("終了ちょうどは止めない（半開区間）", () => {
    expect(isSuppressedAtParts(cfg(), "2026-07-13", 1, 9 * 60 + 40)).toBe(false);
  });
  it("enabled=false は常に止めない", () => {
    expect(isSuppressedAtParts(cfg({ enabled: false }), "2026-07-13", 1, 9 * 60)).toBe(false);
  });
});

describe("jstDateParts（絶対時刻→JST 暦日/曜日/分）", () => {
  it("UTC を JST(+9h) に換算し暦日・曜日も返す", () => {
    // 2026-07-13(月) 00:50 UTC = 2026-07-13(月) 09:50 JST
    const p = jstDateParts(new Date("2026-07-13T00:50:00Z"));
    expect(p).toEqual({ date: "2026-07-13", weekday: 1, minutes: 9 * 60 + 50 });
  });
  it("UTC 夜は JST 翌日に繰り上がる", () => {
    // 2026-07-12(日) 23:00 UTC = 2026-07-13(月) 08:00 JST
    const p = jstDateParts(new Date("2026-07-12T23:00:00Z"));
    expect(p).toEqual({ date: "2026-07-13", weekday: 1, minutes: 8 * 60 });
  });
});

describe("isAdSuppressedAt（now 起点の統合判定）", () => {
  it("平日の授業時間中（JST）は停止する", () => {
    // 2026-07-13(月) 00:00 UTC = 09:00 JST（通常 08:50-09:40 内）
    expect(isAdSuppressedAt(cfg(), new Date("2026-07-13T00:00:00Z"))).toBe(true);
  });
  it("特定日で『広告を止めない』を割り当てた日は停止しない", () => {
    const c = cfg({ overrides: { "2026-07-13": NONE_VARIATION_KEY } });
    expect(isAdSuppressedAt(c, new Date("2026-07-13T00:00:00Z"))).toBe(false);
  });
});

describe("validateAdSuppression（Server Action 入力検証）", () => {
  const okVariations = [NORMAL, SHORT];

  it("正常入力を正規化して返す", () => {
    const res = validateAdSuppression(
      true,
      okVariations,
      { 1: "k-normal", 6: NONE_VARIATION_KEY },
      { "2026-09-30": "k-short" },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.variations).toHaveLength(2);
      expect(res.value.weekdayMap).toEqual({ 1: "k-normal", 6: NONE_VARIATION_KEY });
      expect(res.value.overrides).toEqual({ "2026-09-30": "k-short" });
    }
  });

  it("enabled=false + 空でも許可（停止なしに更新できる）", () => {
    expect(validateAdSuppression(false, [], {}, {}).ok).toBe(true);
  });

  it("キー重複・NONE 予約語・名前空・重なりを拒否", () => {
    expect(validateAdSuppression(true, [NORMAL, { ...SHORT, key: "k-normal" }], {}, {}).ok).toBe(
      false,
    ); // 重複 key
    expect(
      validateAdSuppression(true, [{ key: NONE_VARIATION_KEY, name: "x", ranges: [] }], {}, {}).ok,
    ).toBe(false); // 予約語 key
    expect(validateAdSuppression(true, [{ key: "k", name: "", ranges: [] }], {}, {}).ok).toBe(
      false,
    ); // 名前空
    expect(
      validateAdSuppression(
        true,
        [
          {
            key: "k",
            name: "x",
            ranges: [
              { start: "08:50", end: "09:40" },
              { start: "09:30", end: "10:00" },
            ],
          },
        ],
        {},
        {},
      ).ok,
    ).toBe(false); // 重なり
  });

  it("存在しない key を指す割り当て・不正日付を拒否", () => {
    expect(validateAdSuppression(true, okVariations, { 1: "ghost" }, {}).ok).toBe(false);
    expect(validateAdSuppression(true, okVariations, { 9: "k-normal" }, {}).ok).toBe(false); // 曜日 0..6 外
    expect(validateAdSuppression(true, okVariations, {}, { "2026-02-30": "k-normal" }).ok).toBe(
      false,
    ); // 実在しない日付
    expect(validateAdSuppression(true, okVariations, {}, { "2026-09-30": "ghost" }).ok).toBe(false);
  });

  it("バリエーション数の上限を超えると拒否", () => {
    const many = Array.from({ length: MAX_AD_SUPPRESSION_VARIATIONS + 1 }, (_, i) => ({
      key: `k${i}`,
      name: `t${i}`,
      ranges: [],
    }));
    expect(validateAdSuppression(true, many, {}, {}).ok).toBe(false);
  });
});
