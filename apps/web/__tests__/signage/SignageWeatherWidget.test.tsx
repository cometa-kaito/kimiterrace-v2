import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * F14 (#128 / ADR-021): サイネージ天気ウィジェットの表示配線を検証する。SignageClient に天気ペイロードを
 * 流し込み、(a) 予定列ヘッダーへの天気アイコン表示、(b) isStale 注記、
 * (c) 空/stale の graceful 表示 (weather=null は枠ごと非表示) を確かめる。
 *
 * 2026-06-07 リデザイン: 天気はヘッダー帯から予定列ヘッダーへ移動（ユーザー確定）。各列は
 * scheduleDays[].date と weather.days[].forecastDate を突合して天気を表示する。
 *
 * 2026-06-13 リデザイン: 予定列ヘッダーの天気は **アイコンのみ（文字なし）** に変更（ユーザー確定）。
 * 天気テキストは可視描画しない代わりに、アイコンの親 span の aria-label に保持しスクリーンリーダーへ伝える。
 *
 * NFR05 (色非依存): アイコンは色でなく **形状で区別できる単色グリフ**（☀☁☂❄⚡）。色に依存せず意味が伝わる。
 * AT 向けの代替テキストは aria-label が担う。本テストはグリフが出ること＋ラベルが aria-label に入ること、
 * かつ天気テキストが可視描画されないことを固定する。
 * fail-soft: weather=null でも時間割等の本体は描画され続ける (画面が壊れない)。
 *
 * 純変換 (weatherIconFor / 鮮度判定) は weather.test.ts で別途カバーする。ここは「ウィジェットが
 * その出力を正しく描く」配線部分のみを見る。
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

// 天気アイコンのグリフ（SignageClient の WEATHER_ICON_GLYPH と対応）
const GLYPH_SUNNY = "☀";
const GLYPH_CLOUDY = "☁";

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
    news: null,
    weatherWarnings: null,
    heatAlerts: null,
    blackout: false,
  };
}

describe("SignageClient 予定列ヘッダー天気 (#128 / F14)", () => {
  it("scheduleDays に対応する天気日があるとき予定列ヘッダーにアイコンを出し、文字は出さない", () => {
    render(
      <SignageClient
        basePath={TOKEN}
        initial={payload(weather({}), [scheduleDay("2026-06-02")])}
      />,
    );
    // アイコン（グリフ）が列ヘッダー内に出る。
    expect(screen.getByText(GLYPH_SUNNY)).toBeInTheDocument();
    // 天気テキストは **可視描画しない**（アイコンのみ、2026-06-13 ユーザー）。
    expect(screen.queryByText("晴れ")).toBeNull();
    // ただし意味は aria-label に保持し AT へ伝える（色非依存・NFR05）。
    expect(screen.getByLabelText("晴れ")).toBeInTheDocument();
    // 気温・降水・取得時刻は **出さない** (情報量を絞る、2026-06-07 ユーザー)。
    expect(screen.queryByText(/最高/)).toBeNull();
    expect(screen.queryByText(/降水/)).toBeNull();
    expect(screen.queryByText(/時点/)).toBeNull();
  });

  it("weatherText が無ければ aria-label にアイコンラベルを入れる (色非依存のフォールバック)", () => {
    render(
      <SignageClient
        basePath={TOKEN}
        initial={payload(
          weather({ days: [day({ weatherText: null, icon: "cloudy", iconLabel: "くもり" })] }),
          [scheduleDay("2026-06-02")],
        )}
      />,
    );
    // くもりのグリフが出る。
    expect(screen.getByText(GLYPH_CLOUDY)).toBeInTheDocument();
    // 文字は可視描画されないが aria-label にラベルが入る。
    expect(screen.queryByText("くもり")).toBeNull();
    expect(screen.getByLabelText("くもり")).toBeInTheDocument();
  });

  it("isStale のとき鮮度劣化を色だけでなくテキストで明示する (F14 §3 / NFR05)", () => {
    render(
      <SignageClient
        basePath={TOKEN}
        initial={payload(
          weather({ isStale: true, fetchedAt: new Date("2026-06-01T08:00:00+09:00") }),
          [scheduleDay("2026-06-02")],
        )}
      />,
    );
    // 古い予報でも last-known-good を出し続け (NFR02)、簡潔な注記で明示する。
    expect(screen.getByText("古い予報")).toBeInTheDocument();
    expect(screen.getByText(GLYPH_SUNNY)).toBeInTheDocument(); // アイコン自体は残す。
  });

  it("weather=null なら天気を出さない (fail-soft) が、本体 (予定等) は描画され続ける", () => {
    render(<SignageClient basePath={TOKEN} initial={payload(null, [scheduleDay("2026-06-02")])} />);
    // 天気アイコンは存在しない。
    expect(screen.queryByText(GLYPH_SUNNY)).toBeNull();
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
        basePath={TOKEN}
        initial={payload(weather({ days: manyWeatherDays }), [
          scheduleDay("2026-06-02"),
          scheduleDay("2026-06-03"),
        ])}
      />,
    );
    // 対応する2日はアイコン（aria-label で識別）を表示。
    expect(screen.getByLabelText("予報A")).toBeInTheDocument();
    expect(screen.getByLabelText("予報B")).toBeInTheDocument();
    // 表示されたアイコンは2列ぶん。
    expect(screen.getAllByText(GLYPH_SUNNY)).toHaveLength(2);
    // scheduleDays に無い日の天気は出ない。
    expect(screen.queryByLabelText("予報C")).toBeNull();
  });
});
