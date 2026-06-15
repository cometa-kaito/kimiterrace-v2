import { describe, expect, it, vi } from "vitest";
import type { ParsedForecast } from "../jma.js";
import {
  type FetchedArea,
  type HttpFetchConfig,
  collectAreaCodes,
  fetchAreaFromJma,
  jmaForecastUrl,
  runWeatherFetch,
} from "../run.js";

/**
 * F14 (#128, ADR-021): 天気取得バッチのオーケストレーション + HTTP 取得を、fetch/DB をフェイク注入して
 * 単体検証する（ネットワーク・DB 非依存）。実 PG / RLS の振る舞いは packages/db の
 * weather-forecasts.test.ts（実 PG）でカバーする。
 */

function fakeParsed(areaCode: string): ParsedForecast {
  return {
    areaCode,
    areaName: "テスト地方",
    days: [
      {
        forecastDate: "2026-06-02",
        weatherCode: "100",
        weatherText: "晴れ",
        tempMin: 18,
        tempMax: 28,
        pop: 30,
      },
    ],
  };
}

describe("jmaForecastUrl", () => {
  it("地域コードから bosai forecast URL を組む", () => {
    expect(jmaForecastUrl("210000")).toBe(
      "https://www.jma.go.jp/bosai/forecast/data/forecast/210000.json",
    );
  });
});

describe("collectAreaCodes", () => {
  it("府県から地域コードを導出し dedup する（同一府県の複数校は 1 コード）", () => {
    const codes = collectAreaCodes([
      { prefecture: "岐阜県" },
      { prefecture: "岐阜県" }, // 同一府県 → 畳まれる
      { prefecture: "東京都" },
      { prefecture: " 愛知県 " }, // 前後空白を吸収
    ]);
    expect(codes).toEqual(["210000", "130000", "230000"]);
  });

  it("未知の府県・null は除外する", () => {
    const codes = collectAreaCodes([
      { prefecture: "存在しない県" },
      { prefecture: null },
      { prefecture: "岐阜県" },
    ]);
    expect(codes).toEqual(["210000"]);
  });
});

describe("runWeatherFetch", () => {
  it("全地域を取得・保存し件数を集計する", async () => {
    const summary = await runWeatherFetch({
      listAreaCodes: async () => ["210000", "130000"],
      fetchArea: async (areaCode) => ({ parsed: fakeParsed(areaCode), raw: { a: areaCode } }),
      saveArea: async (area) => area.parsed.days.length,
    });
    expect(summary).toEqual({
      areas: 2,
      fetched: 2,
      rowsUpserted: 2,
      failed: 0,
      failedAreaCodes: [],
    });
  });

  it("1 地域の取得失敗はその地域だけ skip し、他地域は続行する（fail-soft / last-known-good）", async () => {
    const summary = await runWeatherFetch({
      listAreaCodes: async () => ["210000", "999999", "130000"],
      fetchArea: async (areaCode) => {
        if (areaCode === "999999") throw new Error("JMA 404");
        return { parsed: fakeParsed(areaCode), raw: {} };
      },
      saveArea: async (area) => area.parsed.days.length,
    });
    expect(summary.areas).toBe(3);
    expect(summary.fetched).toBe(2);
    expect(summary.rowsUpserted).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.failedAreaCodes).toEqual(["999999"]);
  });

  it("保存(upsert)失敗もその地域だけ skip する", async () => {
    const summary = await runWeatherFetch({
      listAreaCodes: async () => ["210000"],
      fetchArea: async (areaCode) => ({ parsed: fakeParsed(areaCode), raw: {} }),
      saveArea: async () => {
        throw new Error("DB error");
      },
    });
    expect(summary.fetched).toBe(0);
    expect(summary.failed).toBe(1);
    expect(summary.failedAreaCodes).toEqual(["210000"]);
  });

  it("対象地域が無ければ全ゼロのサマリを返す", async () => {
    const summary = await runWeatherFetch({
      listAreaCodes: async () => [],
      fetchArea: async () => ({ parsed: fakeParsed("x"), raw: {} }),
      saveArea: async () => 1,
    });
    expect(summary).toEqual({
      areas: 0,
      fetched: 0,
      rowsUpserted: 0,
      failed: 0,
      failedAreaCodes: [],
    });
  });
});

describe("fetchAreaFromJma", () => {
  const config = (fetchImpl: typeof fetch): HttpFetchConfig => ({
    userAgent: "test-ua/1.0",
    timeoutMs: 1000,
    fetchImpl,
  });

  it("2xx の JSON をパースし raw を保全する。明示 User-Agent を付ける", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>)["User-Agent"]).toBe("test-ua/1.0");
      return new Response(JSON.stringify([]), { status: 200 });
    }) as unknown as typeof fetch;
    const area: FetchedArea = await fetchAreaFromJma("210000", config(fetchImpl));
    expect(area.parsed.areaCode).toBe("210000");
    expect(area.raw).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("非 2xx は throw する（runWeatherFetch が地域単位で捕捉して skip）", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("not found", { status: 404 }),
    ) as unknown as typeof fetch;
    await expect(fetchAreaFromJma("999999", config(fetchImpl))).rejects.toThrow(/status=404/);
  });

  it("timeoutMs が非数値（NaN）でも即 abort せず取得できる（全 fetch 即 abort 回帰）", async () => {
    // 非数値 env（WEATHER_FETCH_TIMEOUT_MS="abc" 等）が NaN として伝播すると、旧実装は
    // `config.timeoutMs ?? 10_000` が NaN を素通しし `setTimeout(abort, NaN)` ≒ 0ms abort で全 fetch を
    // 即座に中断していた。abort signal を尊重するフェイク fetch で「即 abort されない」ことを固定する。
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(
          () => resolve(new Response(JSON.stringify([]), { status: 200 })),
          10,
        );
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        });
      });
    }) as unknown as typeof fetch;

    const area = await fetchAreaFromJma("210000", {
      userAgent: "test-ua/1.0",
      timeoutMs: Number.NaN,
      fetchImpl,
    });
    expect(area.parsed.areaCode).toBe("210000");
  });
});
