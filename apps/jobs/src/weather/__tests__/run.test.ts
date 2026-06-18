import { describe, expect, it, vi } from "vitest";
import type { ParsedHeatAlert } from "../env-heat.js";
import type { ParsedForecast } from "../jma.js";
import type { ParsedWarningSet } from "../jma-warning.js";
import {
  type FetchedArea,
  type FetchedHeat,
  type FetchedWarning,
  type HttpFetchConfig,
  collectAreaCodes,
  envHeatAlertUrl,
  fetchAreaFromJma,
  fetchHeatFromEnv,
  fetchWarningFromJma,
  jmaForecastUrl,
  jmaWarningUrl,
  jstHeatDateParts,
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
  it("全地域を取得・保存し件数を集計する（警報 deps 未指定なら警報は 0）", async () => {
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
      warningsFetched: 0,
      warningsFailed: 0,
      warningsFailedAreaCodes: [],
      heatFetched: 0,
      heatFailed: 0,
      heatFailedAreaCodes: [],
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
      warningsFetched: 0,
      warningsFailed: 0,
      warningsFailedAreaCodes: [],
      heatFetched: 0,
      heatFailed: 0,
      heatFailedAreaCodes: [],
    });
  });
});

function fakeWarning(areaCode: string): ParsedWarningSet {
  return {
    areaCode,
    maxLevel: "warning",
    reportDatetime: "2026-06-18T10:39:00+09:00",
    headline: "テスト警報",
    warnings: [
      { code: "03", name: "大雨警報", level: "warning", status: "発表", areaName: "テスト地方" },
    ],
  };
}

describe("runWeatherFetch（ADR-044 警報相乗り）", () => {
  it("警報 deps 指定時は天気と並走して警報も取得・保存する", async () => {
    const saved: string[] = [];
    const summary = await runWeatherFetch({
      listAreaCodes: async () => ["210000", "130000"],
      fetchArea: async (areaCode) => ({ parsed: fakeParsed(areaCode), raw: {} }),
      saveArea: async (area) => area.parsed.days.length,
      fetchWarning: async (areaCode) => ({ parsed: fakeWarning(areaCode), raw: {} }),
      saveWarning: async (areaCode) => {
        saved.push(areaCode);
      },
    });
    expect(summary.fetched).toBe(2);
    expect(summary.warningsFetched).toBe(2);
    expect(summary.warningsFailed).toBe(0);
    expect(summary.warningsFailedAreaCodes).toEqual([]);
    expect(saved).toEqual(["210000", "130000"]);
  });

  it("★ 警報の取得失敗は天気を壊さない（その地域も天気は保存される / fail-soft）", async () => {
    const summary = await runWeatherFetch({
      listAreaCodes: async () => ["210000"],
      fetchArea: async (areaCode) => ({ parsed: fakeParsed(areaCode), raw: {} }),
      saveArea: async (area) => area.parsed.days.length,
      fetchWarning: async () => {
        throw new Error("JMA warning 404");
      },
      saveWarning: async () => {
        /* 呼ばれない */
      },
    });
    // 天気は成功（警報の失敗に巻き込まれない）。
    expect(summary.fetched).toBe(1);
    expect(summary.rowsUpserted).toBe(1);
    expect(summary.failed).toBe(0);
    // 警報のみその地域を skip。
    expect(summary.warningsFetched).toBe(0);
    expect(summary.warningsFailed).toBe(1);
    expect(summary.warningsFailedAreaCodes).toEqual(["210000"]);
  });

  it("★ 天気の取得失敗でも警報は独立に試行される（逆方向の独立性）", async () => {
    const summary = await runWeatherFetch({
      listAreaCodes: async () => ["210000"],
      fetchArea: async () => {
        throw new Error("JMA forecast 500");
      },
      saveArea: async () => 1,
      fetchWarning: async (areaCode) => ({ parsed: fakeWarning(areaCode), raw: {} }),
      saveWarning: async () => {},
    });
    expect(summary.fetched).toBe(0);
    expect(summary.failed).toBe(1);
    expect(summary.failedAreaCodes).toEqual(["210000"]);
    // 天気が落ちても警報は取れる。
    expect(summary.warningsFetched).toBe(1);
    expect(summary.warningsFailed).toBe(0);
  });

  it("警報の保存(upsert)失敗もその地域だけ skip する", async () => {
    const summary = await runWeatherFetch({
      listAreaCodes: async () => ["210000"],
      fetchArea: async (areaCode) => ({ parsed: fakeParsed(areaCode), raw: {} }),
      saveArea: async (area) => area.parsed.days.length,
      fetchWarning: async (areaCode) => ({ parsed: fakeWarning(areaCode), raw: {} }),
      saveWarning: async () => {
        throw new Error("DB error");
      },
    });
    expect(summary.fetched).toBe(1);
    expect(summary.warningsFetched).toBe(0);
    expect(summary.warningsFailed).toBe(1);
    expect(summary.warningsFailedAreaCodes).toEqual(["210000"]);
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

describe("jmaWarningUrl", () => {
  it("地域コードから bosai warning URL を組む", () => {
    expect(jmaWarningUrl("210000")).toBe(
      "https://www.jma.go.jp/bosai/warning/data/warning/210000.json",
    );
  });
});

describe("fetchWarningFromJma", () => {
  const config = (fetchImpl: typeof fetch): HttpFetchConfig => ({
    userAgent: "test-ua/1.0",
    timeoutMs: 1000,
    fetchImpl,
  });

  it("2xx の警報 JSON をパースし raw を保全する。明示 User-Agent を付ける", async () => {
    const body = {
      reportDatetime: "2026-06-18T10:39:00+09:00",
      headlineText: "テスト見出し",
      areaTypes: [{ areas: [{ name: "美濃地方", warnings: [{ code: "03", status: "発表" }] }] }],
    };
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toContain("/bosai/warning/data/warning/210000.json");
      expect((init?.headers as Record<string, string>)["User-Agent"]).toBe("test-ua/1.0");
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    const w: FetchedWarning = await fetchWarningFromJma("210000", config(fetchImpl));
    expect(w.parsed.areaCode).toBe("210000");
    expect(w.parsed.maxLevel).toBe("warning");
    expect(w.raw).toEqual(body);
  });

  it("非 2xx は throw する（runWeatherFetch が地域単位で捕捉して天気を巻き込まず skip）", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("not found", { status: 404 }),
    ) as unknown as typeof fetch;
    await expect(fetchWarningFromJma("999999", config(fetchImpl))).rejects.toThrow(/status=404/);
  });
});

function fakeHeat(areaCode: string, forecastDate = "2026-07-15"): FetchedHeat {
  const parsed: ParsedHeatAlert = {
    areaCode,
    areaName: "テスト県",
    alertLevel: "warning",
    wbgtMax: 33,
    wbgtBand: "danger",
    raw: {
      areaCode,
      areaName: "テスト県",
      prefName: "テスト",
      targetDate1Flag: "1",
      targetDate2Flag: "0",
      wbgtCells: "テスト:33",
    },
  };
  return { parsed, forecastDate };
}

describe("runWeatherFetch（ADR-044 熱中症相乗り）", () => {
  it("熱中症 deps 指定時は天気・警報と並走して熱中症も取得・保存する", async () => {
    const savedHeat: string[] = [];
    const summary = await runWeatherFetch({
      listAreaCodes: async () => ["210000", "130000"],
      fetchArea: async (areaCode) => ({ parsed: fakeParsed(areaCode), raw: {} }),
      saveArea: async (area) => area.parsed.days.length,
      fetchWarning: async (areaCode) => ({ parsed: fakeWarning(areaCode), raw: {} }),
      saveWarning: async () => {},
      fetchHeat: async (areaCode) => fakeHeat(areaCode),
      saveHeat: async (areaCode) => {
        savedHeat.push(areaCode);
      },
    });
    expect(summary.fetched).toBe(2);
    expect(summary.warningsFetched).toBe(2);
    expect(summary.heatFetched).toBe(2);
    expect(summary.heatFailed).toBe(0);
    expect(summary.heatFailedAreaCodes).toEqual([]);
    expect(savedHeat).toEqual(["210000", "130000"]);
  });

  it("熱中症 deps 未指定なら熱中症は 0（既存の天気/警報のみ呼び出しの後方互換）", async () => {
    const summary = await runWeatherFetch({
      listAreaCodes: async () => ["210000"],
      fetchArea: async (areaCode) => ({ parsed: fakeParsed(areaCode), raw: {} }),
      saveArea: async (area) => area.parsed.days.length,
    });
    expect(summary.heatFetched).toBe(0);
    expect(summary.heatFailed).toBe(0);
    expect(summary.heatFailedAreaCodes).toEqual([]);
  });

  it("★ 熱中症の取得失敗は天気・警報を壊さない（その地域も天気/警報は保存される / fail-soft）", async () => {
    const summary = await runWeatherFetch({
      listAreaCodes: async () => ["210000"],
      fetchArea: async (areaCode) => ({ parsed: fakeParsed(areaCode), raw: {} }),
      saveArea: async (area) => area.parsed.days.length,
      fetchWarning: async (areaCode) => ({ parsed: fakeWarning(areaCode), raw: {} }),
      saveWarning: async () => {},
      fetchHeat: async () => {
        throw new Error("env heat 404");
      },
      saveHeat: async () => {
        /* 呼ばれない */
      },
    });
    // 天気・警報は成功（熱中症の失敗に巻き込まれない）。
    expect(summary.fetched).toBe(1);
    expect(summary.warningsFetched).toBe(1);
    // 熱中症のみその地域を skip。
    expect(summary.heatFetched).toBe(0);
    expect(summary.heatFailed).toBe(1);
    expect(summary.heatFailedAreaCodes).toEqual(["210000"]);
  });

  it("熱中症の保存(upsert)失敗もその地域だけ skip する", async () => {
    const summary = await runWeatherFetch({
      listAreaCodes: async () => ["210000"],
      fetchArea: async (areaCode) => ({ parsed: fakeParsed(areaCode), raw: {} }),
      saveArea: async (area) => area.parsed.days.length,
      fetchHeat: async (areaCode) => fakeHeat(areaCode),
      saveHeat: async () => {
        throw new Error("DB error");
      },
    });
    expect(summary.fetched).toBe(1);
    expect(summary.heatFetched).toBe(0);
    expect(summary.heatFailed).toBe(1);
    expect(summary.heatFailedAreaCodes).toEqual(["210000"]);
  });
});

describe("jstHeatDateParts", () => {
  it("UTC から +9h して JST 暦日を組む（日付跨ぎ）", () => {
    // 2026-07-14T20:00:00Z = 2026-07-15T05:00 JST → 7/15。
    const parts = jstHeatDateParts(new Date("2026-07-14T20:00:00Z"));
    expect(parts.isoDate).toBe("2026-07-15");
    expect(parts.yyyymmdd).toBe("20260715");
    expect(parts.yyyy).toBe("2026");
  });
});

describe("envHeatAlertUrl", () => {
  it("年・日付・発表時刻から環境省 alert CSV URL を組む（既定 17 時）", () => {
    expect(envHeatAlertUrl("2026", "20260715")).toBe(
      "https://www.wbgt.env.go.jp/alert/dl/2026/alert_20260715_17.csv",
    );
    expect(envHeatAlertUrl("2026", "20260715", "05")).toBe(
      "https://www.wbgt.env.go.jp/alert/dl/2026/alert_20260715_05.csv",
    );
  });
});

describe("fetchHeatFromEnv", () => {
  const config = (fetchImpl: typeof fetch): HttpFetchConfig => ({
    userAgent: "test-ua/1.0",
    timeoutMs: 1000,
    fetchImpl,
  });

  it("2xx の CSV を text で取得し該当地域行をパースする。明示 User-Agent を付ける。forecastDate は当日(JST)", async () => {
    const body = [
      "府県予報区,a,b,府県予報区等コード,都道府県名,e,TargetDate1フラグ,TargetDate2フラグ,日最高WBGT（10:00）,日最高WBGT（17:00）,日最高WBGT（5:00）",
      "岐阜県,52,0,210000,岐阜,21,1,0,岐阜:33,,",
    ].join("\n");
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toContain("/alert/dl/");
      expect(String(url)).toContain("/alert_");
      expect((init?.headers as Record<string, string>)["User-Agent"]).toBe("test-ua/1.0");
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
    const heat: FetchedHeat = await fetchHeatFromEnv("210000", config(fetchImpl));
    expect(heat.parsed.areaCode).toBe("210000");
    expect(heat.parsed.alertLevel).toBe("warning");
    expect(heat.parsed.wbgtMax).toBe(33);
    // forecastDate は JST 暦日（'YYYY-MM-DD'）。
    expect(heat.forecastDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("非 2xx は throw する（runWeatherFetch が地域単位で捕捉して天気・警報を巻き込まず skip）", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("not found", { status: 404 }),
    ) as unknown as typeof fetch;
    await expect(fetchHeatFromEnv("210000", config(fetchImpl))).rejects.toThrow(/status=404/);
  });
});
