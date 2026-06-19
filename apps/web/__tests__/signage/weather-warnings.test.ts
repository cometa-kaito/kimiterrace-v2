import {
  type SignageWarningItem,
  toSignageWarningItems,
  toSignageWeatherWarning,
} from "@/lib/signage/weather-warnings";
import { DEFAULT_STALENESS_THRESHOLD_MS } from "@/lib/signage/weather";
import type { WeatherWarning } from "@kimiterrace/db";
import { describe, expect, it } from "vitest";

/**
 * ADR-044: サイネージ気象警報・注意報の **表示用純変換**（jsonb 射影 / 鮮度 / 行→ペイロード）を検証する。
 * RLS / 実 PG 読み取りは packages/db の weather-warnings.test.ts でカバーする（読みは RLS read_all 委譲）。
 *
 * NFR05（色非依存）: 段階（maxLevel）は色だけでなく段階ラベルと対で UI が出すため、ここでは段階値が
 * 欠落なく射影されること・解除済みが除かれることを固定する。
 */

/** weather_warnings 1 行の最小フェイク（テストで使う列のみ、型は schema 由来）。 */
function row(overrides: Partial<WeatherWarning>): WeatherWarning {
  return {
    id: "00000000-0000-0000-0000-000000000000",
    areaCode: "210000",
    areaName: "岐阜県",
    source: "jma",
    fetchedAt: new Date("2026-07-01T09:00:00+09:00"),
    reportDatetime: new Date("2026-07-01T08:50:00+09:00"),
    headline: "大雨に警戒してください",
    maxLevel: "warning",
    warnings: [],
    raw: {},
    createdAt: new Date("2026-07-01T09:00:00+09:00"),
    updatedAt: new Date("2026-07-01T09:00:00+09:00"),
    createdBy: null,
    updatedBy: null,
    ...overrides,
  };
}

describe("toSignageWarningItems（jsonb 射影・fail-soft）", () => {
  it("正常な配列を表示用に射影する（code/name/level/status）", () => {
    const items = toSignageWarningItems([
      { code: "03", name: "大雨警報", level: "warning", status: "発表", areaName: "美濃" },
    ]);
    expect(items).toEqual<SignageWarningItem[]>([
      { code: "03", name: "大雨警報", level: "warning", status: "発表" },
    ]);
  });

  it("解除済み（status が '解除' / '0'）は現況でないので除外する", () => {
    const items = toSignageWarningItems([
      { code: "03", name: "大雨警報", level: "warning", status: "解除" },
      { code: "10", name: "強風注意報", level: "advisory", status: "0" },
      { code: "08", name: "洪水警報", level: "warning", status: "発表" },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.name).toBe("洪水警報");
  });

  it("配列でない / null / 想定外要素は空配列に倒す（盤面を壊さない）", () => {
    expect(toSignageWarningItems(null)).toEqual([]);
    expect(toSignageWarningItems(undefined)).toEqual([]);
    expect(toSignageWarningItems("not-array")).toEqual([]);
    expect(toSignageWarningItems({})).toEqual([]);
    // 配列だが要素が非オブジェクト（混入）はスキップ。
    expect(toSignageWarningItems([null, 1, "x"])).toEqual([]);
  });

  it("欠落フィールドは null に倒す（部分的な原文でも落ちない）", () => {
    const items = toSignageWarningItems([{ name: "雷注意報" }]);
    expect(items[0]).toEqual<SignageWarningItem>({
      code: null,
      name: "雷注意報",
      level: null,
      status: null,
    });
  });
});

describe("toSignageWeatherWarning（行→ペイロード・鮮度）", () => {
  const now = new Date("2026-07-01T12:00:00+09:00");

  it("行を表示ペイロードへ射影し、解除以外の警報だけを残す", () => {
    const out = toSignageWeatherWarning(
      row({
        maxLevel: "emergency",
        warnings: [
          { code: "03", name: "大雨特別警報", level: "emergency", status: "発表" },
          { code: "33", name: "大雨警報", level: "warning", status: "解除" },
        ],
      }),
      now,
    );
    expect(out.areaCode).toBe("210000");
    expect(out.areaName).toBe("岐阜県");
    expect(out.maxLevel).toBe("emergency");
    expect(out.headline).toBe("大雨に警戒してください");
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]?.name).toBe("大雨特別警報");
    expect(out.isStale).toBe(false);
  });

  it("fetched_at が古ければ isStale=true（last-known-good 注記）", () => {
    const stale = row({
      fetchedAt: new Date(now.getTime() - (DEFAULT_STALENESS_THRESHOLD_MS + 1000)),
    });
    expect(toSignageWeatherWarning(stale, now).isStale).toBe(true);
  });

  // fetched_at は DB 上 NOT NULL（行は必ず取得時刻を持つ）。null 入力の鮮度挙動は isForecastStale の
  // 単体（weather.test.ts）でカバー済みなので、ここでは行射影の範囲に絞る。

  it("maxLevel='none'（警報なし）でも行は射影する（帯を出すか否かは UI 判断）", () => {
    const out = toSignageWeatherWarning(row({ maxLevel: "none", warnings: [] }), now);
    expect(out.maxLevel).toBe("none");
    expect(out.warnings).toEqual([]);
  });
});
