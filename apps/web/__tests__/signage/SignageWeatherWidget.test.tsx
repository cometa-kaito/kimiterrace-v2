import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * F14 (#128 / ADR-021): サイネージ天気ウィジェットの表示配線を検証する。SignageClient に天気ペイロードを
 * 流し込み、(a) 予報の描画 (アイコンラベル + 気温 + 降水確率 + 「○時時点」鮮度注記)、(b) stale 注記、
 * (c) 空/stale の graceful 表示 (weather=null は枠ごと非表示 / days=[] は黙らず注記) を確かめる。
 *
 * NFR05 (色非依存): アイコンは glyph + 日本語ラベル併記。本テストはラベルテキストが必ず出ることで色非依存を固定。
 * fail-soft: weather=null でも時間割等の本体は描画され続ける (画面が壊れない)。
 *
 * 純変換 (weatherIconFor / 鮮度判定) は weather.test.ts で別途カバーする。ここは「ウィジェットが
 * その出力をテキストで正しく描く」配線部分のみを見る。
 */

// SignageClient はマウント時に SW 登録・media prefetch・event beacon を走らせるので no-op 化して副作用を断つ
// (既存 SignageClient.test.tsx と同方針)。天気ウィジェット描画自体はこれらに依存しない。
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

function payload(weatherValue: SignageWeather | null): SignagePayload {
  return { date: "2026-06-02", daily, scheduleDays: [], ads: [], weather: weatherValue };
}

describe("SignageClient 天気ウィジェット (#128 / F14)", () => {
  it("予報を描画する: 地域名・天気テキスト・気温・降水確率・取得時刻", () => {
    render(<SignageClient classToken={TOKEN} initial={payload(weather({}))} />);

    // 地域名つきの領域ラベル (色非依存のテキスト)。
    expect(screen.getByRole("region", { name: "天気 (美濃地方)" })).toBeInTheDocument();
    // 天気テキスト (weatherText 優先)。
    expect(screen.getByText("晴れ")).toBeInTheDocument();
    // 気温・降水確率は数値テキストで併記 (色だけに依存しない、NFR05)。
    expect(screen.getByText("最高 28° / 最低 18°")).toBeInTheDocument();
    expect(screen.getByText("降水 30%")).toBeInTheDocument();
    // 「○時時点」の鮮度注記 (JST 08:00)。
    expect(screen.getByText(/時点/)).toBeInTheDocument();
  });

  it("weatherText が無ければアイコンラベルを本文に出す (色非依存のフォールバック)", () => {
    render(
      <SignageClient
        classToken={TOKEN}
        initial={payload(weather({ days: [day({ weatherText: null, iconLabel: "くもり" })] }))}
      />,
    );
    expect(screen.getByText("くもり")).toBeInTheDocument();
  });

  it("欠損値 (気温/降水) は空白でなく — で埋める (黙った空表示を禁止)", () => {
    render(
      <SignageClient
        classToken={TOKEN}
        initial={payload(weather({ days: [day({ tempMax: null, tempMin: null, pop: null })] }))}
      />,
    );
    expect(screen.getByText("最高 — / 最低 —")).toBeInTheDocument();
    expect(screen.getByText("降水 —%")).toBeInTheDocument();
  });

  it("isStale のとき鮮度劣化を色だけでなくテキストで明示する (F14 §3 / NFR05)", () => {
    render(
      <SignageClient
        classToken={TOKEN}
        initial={payload(
          weather({ isStale: true, fetchedAt: new Date("2026-06-01T08:00:00+09:00") }),
        )}
      />,
    );
    // 古い予報でも last-known-good を出し続け (NFR02)、注記で明示する。
    expect(screen.getByText(/最新の取得に失敗/)).toBeInTheDocument();
    expect(screen.getByText("晴れ")).toBeInTheDocument(); // 予報自体は残す。
  });

  it("weather=null ならウィジェットを出さない (fail-soft) が、本体 (時間割等) は描画され続ける", () => {
    render(<SignageClient classToken={TOKEN} initial={payload(null)} />);
    // 天気領域は存在しない。
    expect(screen.queryByRole("region", { name: /天気/ })).toBeNull();
    // 画面の他要素 (予定セクション等) は壊れず出る。
    expect(screen.getByRole("region", { name: "予定" })).toBeInTheDocument();
  });

  it("days が空でも黙らず「予報データがありません」を出す (空表示禁止)", () => {
    render(<SignageClient classToken={TOKEN} initial={payload(weather({ days: [] }))} />);
    expect(screen.getByText("予報データがありません")).toBeInTheDocument();
  });

  it("本日 + 翌日の 2 日に丸める (視認性、2026-06-03 確定 F14 表示範囲)", () => {
    const manyDays = Array.from({ length: 8 }, (_, i) =>
      day({ forecastDate: `2026-06-0${i + 1}`.slice(0, 10), weatherText: `予報${i}` }),
    );
    render(<SignageClient classToken={TOKEN} initial={payload(weather({ days: manyDays }))} />);
    // 本日 + 翌日 = 先頭 2 日まで表示、3 日目以降は出さない。
    expect(screen.getByText("予報0")).toBeInTheDocument();
    expect(screen.getByText("予報1")).toBeInTheDocument();
    expect(screen.queryByText("予報2")).toBeNull();
  });
});
