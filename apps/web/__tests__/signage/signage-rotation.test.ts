import {
  DEFAULT_AD_MS,
  MAX_AD_MS,
  MIN_AD_MS,
  POLL_BASE_MS,
  POLL_JITTER_RATIO,
  clampAdDurationMs,
  clampIndex,
  jitteredPollMs,
  jstDateString,
  nextIndex,
  parseSignageDate,
  previousBusinessDay,
  signageScheduleDates,
} from "@/lib/signage/rotation";
import { describe, expect, it } from "vitest";

describe("previousBusinessDay（前日コピー F3 の前営業日）", () => {
  // 2026-06-05 金 / 06-06 土 / 06-07 日 / 06-08 月 / 06-09 火（signageScheduleDates と同じ暦アンカー）。
  it("平日は直前の平日を返す（火→月・金→木）", () => {
    expect(previousBusinessDay("2026-06-09")).toBe("2026-06-08");
    expect(previousBusinessDay("2026-06-05")).toBe("2026-06-04");
  });
  it("月曜は金曜を返す（週末をスキップ）", () => {
    expect(previousBusinessDay("2026-06-08")).toBe("2026-06-05");
  });
  it("土日は直前の金曜を返す", () => {
    expect(previousBusinessDay("2026-06-06")).toBe("2026-06-05");
    expect(previousBusinessDay("2026-06-07")).toBe("2026-06-05");
  });
  it("不正な日付は null（fail-soft）", () => {
    expect(previousBusinessDay("2026-13-40")).toBeNull();
    expect(previousBusinessDay("bad")).toBeNull();
    expect(previousBusinessDay("2026-02-30")).toBeNull();
  });
});

describe("signageScheduleDates", () => {
  // 2026-06-06 は土曜 / 06-05 金 / 06-03 水 / 06-08 月 / 06-09 火 / 12-31 木 (基準曜日)。
  it("平日起点は v1 の今後N平日と一致する (水→水木金)", () => {
    expect(signageScheduleDates("2026-06-03", 3)).toEqual([
      "2026-06-03",
      "2026-06-04",
      "2026-06-05",
    ]);
  });

  it("金曜起点は土日を飛ばす (金→金月火)", () => {
    expect(signageScheduleDates("2026-06-05", 3)).toEqual([
      "2026-06-05",
      "2026-06-08",
      "2026-06-09",
    ]);
  });

  it("週末起点は先頭にその週末日を固定し2列目以降を平日で埋める (土→土月火)", () => {
    expect(signageScheduleDates("2026-06-06", 3)).toEqual([
      "2026-06-06",
      "2026-06-08",
      "2026-06-09",
    ]);
  });

  it("月跨ぎ・年跨ぎでも連続する (木→木金月、土日スキップ)", () => {
    expect(signageScheduleDates("2026-12-31", 3)).toEqual([
      "2026-12-31",
      "2027-01-01",
      "2027-01-04",
    ]);
  });

  it("不正な日付・count<=0 は空配列 (fail-soft)", () => {
    expect(signageScheduleDates("2026-13-40", 3)).toEqual([]);
    expect(signageScheduleDates("not-a-date", 3)).toEqual([]);
    expect(signageScheduleDates("2026-06-06", 0)).toEqual([]);
  });

  // pattern3（廊下版）の 5 平日ケース。日数の単一ソースは design-pattern.ts の SIGNAGE_SCHEDULE_DAY_COUNT
  // （パターン別）へ移管済（design-pattern.test.ts で値を検証）。ここは date 生成器が count=5 で 5 平日を
  // 返すことだけを固定する。2026-06-03(水) 起点 → 水木金月火（土日 06-06/07 をスキップ）。
  it("count=5 は水曜起点で 5 平日を返す（pattern3 廊下版の列数）", () => {
    expect(signageScheduleDates("2026-06-03", 5)).toEqual([
      "2026-06-03",
      "2026-06-04",
      "2026-06-05",
      "2026-06-08",
      "2026-06-09",
    ]);
  });
});

/**
 * #48-E2 サイネージ再生制御の純粋ロジック。DB/DOM 非依存でローテーション・ポーリング間隔・
 * JST 日付の境界を固定する (RLS 込みの取得は signage-display.ts の integration テスト領域)。
 */
describe("clampAdDurationMs", () => {
  it("正常な秒数を ms に変換する", () => {
    expect(clampAdDurationMs(10)).toBe(10_000);
    expect(clampAdDurationMs(30)).toBe(30_000);
  });

  it("不正値 (0/負/非有限) は既定値に丸める", () => {
    expect(clampAdDurationMs(0)).toBe(DEFAULT_AD_MS);
    expect(clampAdDurationMs(-5)).toBe(DEFAULT_AD_MS);
    expect(clampAdDurationMs(Number.NaN)).toBe(DEFAULT_AD_MS);
    expect(clampAdDurationMs(Number.POSITIVE_INFINITY)).toBe(DEFAULT_AD_MS);
  });

  it("範囲外は下限・上限へクランプする (広告が一瞬/固着するのを防ぐ)", () => {
    expect(clampAdDurationMs(1)).toBe(MIN_AD_MS); // 1s → 3s 下限
    expect(clampAdDurationMs(9999)).toBe(MAX_AD_MS); // 上限 120s
  });
});

describe("nextIndex / clampIndex", () => {
  it("循環する", () => {
    expect(nextIndex(0, 3)).toBe(1);
    expect(nextIndex(2, 3)).toBe(0);
  });

  it("空 (length<=0) は 0 を返す", () => {
    expect(nextIndex(0, 0)).toBe(0);
    expect(clampIndex(5, 0)).toBe(0);
  });

  it("件数減で範囲外を指したら丸める (ポーリングで広告が減った場合)", () => {
    expect(clampIndex(4, 3)).toBe(1);
    expect(clampIndex(2, 3)).toBe(2);
  });
});

describe("jitteredPollMs", () => {
  it("rnd=0.5 ならジッタ 0 で基準値", () => {
    expect(jitteredPollMs(POLL_BASE_MS, POLL_JITTER_RATIO, () => 0.5)).toBe(POLL_BASE_MS);
  });

  it("rnd 端で ±ratio の範囲に収まる (50 台の位相分散)", () => {
    const lo = jitteredPollMs(POLL_BASE_MS, POLL_JITTER_RATIO, () => 0);
    const hi = jitteredPollMs(POLL_BASE_MS, POLL_JITTER_RATIO, () => 1);
    expect(lo).toBe(POLL_BASE_MS - POLL_JITTER_RATIO * POLL_BASE_MS); // 8s
    expect(hi).toBe(POLL_BASE_MS + POLL_JITTER_RATIO * POLL_BASE_MS); // 12s
    expect(lo).toBeGreaterThanOrEqual(MIN_AD_MS);
  });
});

describe("jstDateString", () => {
  it("UTC 深夜でも JST の日付 (翌日) を返す", () => {
    // 2026-05-31T15:30:00Z = 2026-06-01T00:30 JST
    expect(jstDateString(new Date("2026-05-31T15:30:00Z"))).toBe("2026-06-01");
  });

  it("JST 日中は同日", () => {
    // 2026-05-31T03:00:00Z = 2026-05-31T12:00 JST
    expect(jstDateString(new Date("2026-05-31T03:00:00Z"))).toBe("2026-05-31");
  });
});

describe("parseSignageDate", () => {
  // フォールバック比較用の固定 now (= JST 2026-06-01)。
  const NOW = new Date("2026-05-31T15:30:00Z");
  const TODAY = jstDateString(NOW); // "2026-06-01"

  it("実在する YYYY-MM-DD はそのまま返す", () => {
    expect(parseSignageDate("2026-06-02", NOW)).toBe("2026-06-02");
    expect(parseSignageDate("2024-02-29", NOW)).toBe("2024-02-29"); // 閏日
    expect(parseSignageDate("2026-12-31", NOW)).toBe("2026-12-31");
  });

  it("形式は通るが無効な暦日は今日へフォールバック (pg date 比較の 500 を防ぐ)", () => {
    expect(parseSignageDate("2026-13-45", NOW)).toBe(TODAY); // 13 月 45 日
    expect(parseSignageDate("2026-02-31", NOW)).toBe(TODAY); // 2/31 は存在しない
    expect(parseSignageDate("2026-00-10", NOW)).toBe(TODAY); // 0 月
    expect(parseSignageDate("2026-06-00", NOW)).toBe(TODAY); // 0 日
    expect(parseSignageDate("0000-00-00", NOW)).toBe(TODAY);
    expect(parseSignageDate("2025-02-29", NOW)).toBe(TODAY); // 非閏年の閏日
  });

  it("フォーマット不正は今日へフォールバック", () => {
    expect(parseSignageDate("2026/06/02", NOW)).toBe(TODAY);
    expect(parseSignageDate("2026-6-2", NOW)).toBe(TODAY);
    expect(parseSignageDate("20260602", NOW)).toBe(TODAY);
    expect(parseSignageDate("2026-06-02T00:00", NOW)).toBe(TODAY);
    expect(parseSignageDate("nope", NOW)).toBe(TODAY);
  });

  it("未指定 (null/undefined/空) は今日へフォールバック", () => {
    expect(parseSignageDate(null, NOW)).toBe(TODAY);
    expect(parseSignageDate(undefined, NOW)).toBe(TODAY);
    expect(parseSignageDate("", NOW)).toBe(TODAY);
  });
});
