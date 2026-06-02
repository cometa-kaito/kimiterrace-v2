import {
  DEFAULT_STALENESS_THRESHOLD_MS,
  type WeatherIcon,
  isForecastStale,
  toSignageWeather,
  weatherIconFor,
  weatherIconLabel,
} from "@/lib/signage/weather";
import type { WeatherForecast } from "@kimiterrace/db";
import { describe, expect, it } from "vitest";

/**
 * F14 (#128, ADR-021): サイネージ天気の **表示用純変換**（アイコンマッピング / 鮮度 / 行→ペイロード）を
 * 検証する。RLS / 実 PG 読み取りは packages/db の weather-forecasts.test.ts でカバーする。
 *
 * NFR05（色非依存）: アイコンキーは必ずラベル（テキスト）と対で返ることを固定する。
 */

/** weather_forecasts 1 行の最小フェイク（テストで使う列のみ、型は schema 由来）。 */
function row(overrides: Partial<WeatherForecast>): WeatherForecast {
  return {
    id: "00000000-0000-0000-0000-000000000000",
    areaCode: "210000",
    areaName: "美濃地方",
    source: "jma",
    fetchedAt: new Date("2026-06-02T00:00:00+09:00"),
    forecastDate: "2026-06-02",
    weatherCode: "100",
    weatherText: "晴れ",
    tempMin: 18,
    tempMax: 28,
    pop: 30,
    raw: {},
    createdAt: new Date("2026-06-02T00:00:00+09:00"),
    updatedAt: new Date("2026-06-02T00:00:00+09:00"),
    createdBy: null,
    updatedBy: null,
    ...overrides,
  };
}

describe("weatherIconFor", () => {
  it("百の位で晴/曇/雨/雪に大別する", () => {
    expect(weatherIconFor("100")).toBe("sunny");
    expect(weatherIconFor("101")).toBe("sunny");
    expect(weatherIconFor("200")).toBe("cloudy");
    expect(weatherIconFor("300")).toBe("rainy");
    expect(weatherIconFor("400")).toBe("snowy");
  });
  it("雷コード(450)は thunder を優先", () => {
    expect(weatherIconFor("450")).toBe("thunder");
  });
  it("null / 空 / 非数値 / 範囲外は unknown", () => {
    expect(weatherIconFor(null)).toBe("unknown");
    expect(weatherIconFor("")).toBe("unknown");
    expect(weatherIconFor("abc")).toBe("unknown");
    expect(weatherIconFor("700")).toBe("unknown");
  });
});

describe("weatherIconLabel（NFR05: 色非依存のテキスト併記）", () => {
  it("全アイコンキーに非空ラベルがある", () => {
    const icons: WeatherIcon[] = ["sunny", "cloudy", "rainy", "snowy", "thunder", "unknown"];
    for (const icon of icons) {
      expect(weatherIconLabel(icon).length).toBeGreaterThan(0);
    }
  });
});

describe("isForecastStale", () => {
  const now = new Date("2026-06-02T12:00:00+09:00");
  it("しきい値以内は新鮮", () => {
    const fetched = new Date(now.getTime() - 1 * 60 * 60 * 1000); // 1h 前
    expect(isForecastStale(fetched, now)).toBe(false);
  });
  it("しきい値超過は stale", () => {
    const fetched = new Date(now.getTime() - (DEFAULT_STALENESS_THRESHOLD_MS + 1000));
    expect(isForecastStale(fetched, now)).toBe(true);
  });
  it("fetchedAt が null は stale 扱い（空表示を禁止し注記を出すため）", () => {
    expect(isForecastStale(null, now)).toBe(true);
  });
});

describe("toSignageWeather", () => {
  const now = new Date("2026-06-02T12:00:00+09:00");

  it("行群をアイコン付きの日次に変換し、最新 fetched_at を代表値にする", () => {
    const older = row({
      forecastDate: "2026-06-02",
      fetchedAt: new Date("2026-06-02T05:00:00+09:00"),
    });
    const newer = row({
      forecastDate: "2026-06-03",
      weatherCode: "300",
      weatherText: "雨",
      fetchedAt: new Date("2026-06-02T11:00:00+09:00"),
    });
    const out = toSignageWeather("210000", [older, newer], now);

    expect(out.areaCode).toBe("210000");
    expect(out.areaName).toBe("美濃地方");
    expect(out.days).toHaveLength(2);
    expect(out.days[0]?.icon).toBe("sunny");
    expect(out.days[0]?.iconLabel).toBe("晴れ");
    expect(out.days[1]?.icon).toBe("rainy");
    // 代表 fetched_at は新しい方（11:00）。1h 以内なので新鮮。
    expect(out.fetchedAt?.toISOString()).toBe(new Date("2026-06-02T11:00:00+09:00").toISOString());
    expect(out.isStale).toBe(false);
  });

  it("最新 fetched_at が古ければ isStale=true（last-known-good 注記、F14 §3）", () => {
    const stale = row({ fetchedAt: new Date("2026-06-01T12:00:00+09:00") }); // 24h 前
    const out = toSignageWeather("210000", [stale], now);
    expect(out.isStale).toBe(true);
  });

  it("空配列は days=[] / fetchedAt=null / isStale=true", () => {
    const out = toSignageWeather("210000", [], now);
    expect(out.days).toEqual([]);
    expect(out.fetchedAt).toBeNull();
    expect(out.isStale).toBe(true);
  });
});
