import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * F14 (#128 / ADR-021): サイネージ天気ウィジェットの表示配線を検証する。SignageClient に天気ペイロードを
 * 流し込み、(a) 予定列ヘッダーへの天気表示（アイコンラベル + 天気テキスト）、(b) isStale 注記、
 * (c) 空/stale の graceful 表示 (weather=null は枠ごと非表示) を確かめる。
 *
 * 2026-06-07 リデザイン: 天気はヘッダー帯から予定列ヘッダーへ移動（ユーザー確定）。各列は
 * scheduleDays[].date と weather.days[].forecastDate を突合して天気を表示する。
 *
 * NFR05 (色非依存): アイコンは glyph + 日本語ラベル併記。本テストはラベルテキストが必ず出ることで色非依存を固定。
 * fail-soft: weather=null でも時間割等の本体は描画され続ける (画面が壊れない)。
 *
 * 純変換 (weatherIconFor / 鮮度判定) は weather.test.ts で別途カバーする。ここは「ウィジェットが
 * その出力をテキストで正しく描く」配線部分のみを見る。
 */

// SignageClient はマウント時に SW 登録・media prefetch・event beacon を走らせるので no-op 化して副作用を断つ
vi.mock("@/lib/signage/event-beacon", () => ({
  sendSignageEvent: vi.fn(),
  getClientId: vi.fn(() => ""),
}));
vi.mock("@/lib/signage/media-cache", () => ({
  registerSignageServiceWorker: vi.fn(() => Promise.resolve()),
  prefetchMedia: vi.fn(() => Promise.resolve()),
  cleanupStaleMedia: vi.fn(() => Promise.resolve()),
  selectPrefetchUrls: vi.fn(() => []),
}));

import { SignageClient } from "../../app/(signage)/signage/[classToken]/_components/SignageClient";
import type { SignagePayload } from "../../lib/signage/signage-display";
import type { SignageWeather, WeatherDay } from "../../lib/signage/weather";

const TOKEN = "TOK";

const emptySection = { items: [] as never[], source: null };
const daily = {
  date: "2026-06-02",
  schedules: emptySection,
  notices: emptySection,
  assignments: emptySection,
  quietHours: emptySection,
};

function day(overrides: Partial<WeatherDay>): WeatherDay {
  return {
    forecastDate: "2026-06-02",
    weatherCode: "100",
    weatherText: "晴れ",
    icon: "sunny",
    iconLabel: "晴れ",
    tempMin: 18,
    tempMax: 28,
    pop: 30,
    ...overrides,
  };
}

function weather(overrides: Partial<SignageWeather>): SignageWeather {
  return {
    areaCode: "210000",
    areaName: "美濃地方",
    fetchedAt: new Date("2026-06-02T08:00:00+09:00"),
    isStale: false,
    days: [day({})],
    ...overrides,
  };
}

/** scheduleDays に日付エントリを作る（天気と突合するために date が一致する列が必要）。 */
function scheduleDay(date: string) {
  return { date, schedule: { items: [], source: null } };
}

function payload(
  weatherValue: SignageWeather | null,
  scheduleDays: SignagePayload["scheduleDays"] = [],
): SignagePayload {
  return {
    date: "2026-06-02",
    designPattern: "pattern1",
    daily,
    scheduleDays,
    ads: [],
    weather: weatherValue,
    classContext: { departmentName: null, gradeName: null, className: null },
    presenceCount: null,
    visitors: null,
    callouts: null,
    trainStatus: null,
  };
}

describe("SignageClient 予定列ヘッダー天気 (#128 / F14)", () => {
  it("scheduleDays に対応する天気日が存在するとき予定列ヘッダーに天気テキストを出す", () => {
    render(
      <SignageClient
        classToken={TOKEN}
        initial={payload(weather({}), [scheduleDay("2026-06-02")])}
      />,
    );
    // 天気テキスト (weatherText 優先) が列ヘッダー内に出る。
    expect(screen.getByText("晴れ")).toBeInTheDocument();
    // 気温・降水・取得時刻は **出さない** (情報量を絞る、2026-06-07 ユーザー)。
    expect(screen.queryByText(/最高/)).toBeNull();
    expect(screen.queryByText(/降水/)).toBeNull();
    expect(screen.queryByText(/時点/)).toBeNull();
  });

  it("weatherText が無ければアイコンラベルを本文に出す (色非依存のフォールバック)", () => {
    render(
      <SignageClient
        classToken={TOKEN}
        initial={payload(weather({ days: [day({ weatherText: null, iconLabel: "くもり" })] }), [
          scheduleDay("2026-06-02"),
        ])}
      />,
    );
    expect(screen.getByText("くもり")).toBeInTheDocument();
  });

  it("isStale のとき鮮度劣化を色だけでなくテキストで明示する (F14 §3 / NFR05)", () => {
    render(
      <SignageClient
        classToken={TOKEN}
        initial={payload(
          weather({ isStale: true, fetchedAt: new Date("2026-06-01T08:00:00+09:00") }),
          [scheduleDay("2026-06-02")],
        )}
      />,
    );
    // 古い予報でも last-known-good を出し続け (NFR02)、簡潔な注記で明示する。
    expect(screen.getByText("古い予報")).toBeInTheDocument();
    expect(screen.getByText("晴れ")).toBeInTheDocument(); // 予報自体は残す。
  });

  it("weather=null なら天気を出さない (fail-soft) が、本体 (予定等) は描画され続ける", () => {
    render(
      <SignageClient classToken={TOKEN} initial={payload(null, [scheduleDay("2026-06-02")])} />,
    );
    // 天気テキストは存在しない。
    expect(screen.queryByText("晴れ")).toBeNull();
    // 画面の他要素 (予定セクション等) は壊れず出る。
    expect(screen.getByRole("region", { name: "予定" })).toBeInTheDocument();
  });

  it("scheduleDays に対応する日付の天気のみ列に表示し、無い日付は天気なし", () => {
    const manyWeatherDays = [
      day({ forecastDate: "2026-06-02", weatherText: "予報A" }),
      day({ forecastDate: "2026-06-03", weatherText: "予報B" }),
      day({ forecastDate: "2026-06-04", weatherText: "予報C" }),
    ];
    render(
      <SignageClient
        classToken={TOKEN}
        initial={payload(weather({ days: manyWeatherDays }), [
          scheduleDay("2026-06-02"),
          scheduleDay("2026-06-03"),
        ])}
      />,
    );
    // 対応する2日は表示。
    expect(screen.getByText("予報A")).toBeInTheDocument();
    expect(screen.getByText("予報B")).toBeInTheDocument();
    // scheduleDays に無い日の天気は出ない。
    expect(screen.queryByText("予報C")).toBeNull();
  });
});
