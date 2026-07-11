import type { EnabledCalendarSource } from "@kimiterrace/db";
import { describe, expect, it, vi } from "vitest";
import type { ParsedCalendarEvent } from "../../calendar/ical.js";
import type { ParsedAirQuality } from "../env-air.js";
import type { ParsedHeatAlert } from "../env-heat.js";
import type { ParsedForecast } from "../jma.js";
import type { ParsedWarningSet } from "../jma-warning.js";
import {
  type FetchedAir,
  type FetchedArea,
  type FetchedCalendar,
  type FetchedHeat,
  type FetchedWarning,
  type HttpFetchConfig,
  MAX_EVENTS_PER_SOURCE,
  collectAreaCodes,
  envHeatAlertUrl,
  fetchAirFromEnv,
  fetchAreaFromJma,
  fetchHeatFromEnv,
  fetchIcs,
  fetchWarningFromJma,
  heatAlertCandidates,
  jmaForecastUrl,
  jmaWarningUrl,
  jstHeatDateParts,
  parseSoramameLatest,
  runWeatherFetch,
  soramameAirMetadataUrl,
  soramameNoudoAllUrl,
  stableEventUid,
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
      airFetched: 0,
      airFailed: 0,
      airFailedAreaCodes: [],
      calendarSources: 0,
      calendarFetched: 0,
      calendarRowsUpserted: 0,
      calendarFailed: 0,
      calendarFailedSourceIds: [],
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
      airFetched: 0,
      airFailed: 0,
      airFailedAreaCodes: [],
      calendarSources: 0,
      calendarFetched: 0,
      calendarRowsUpserted: 0,
      calendarFailed: 0,
      calendarFailedSourceIds: [],
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

describe("heatAlertCandidates", () => {
  // ★ 公開時刻(HH)非依存（本 fix）: 最新順候補 `今日17 → 今日05 → 昨日17` を返すことを固定する。
  // `at` は UTC で渡し、+9h の JST 換算（jstHeatDateParts 流儀）を検証する。
  it("now=JST 18:00 → [今日17, 今日05, 昨日17] を最新順で返す", () => {
    // 2026-07-15T09:00:00Z = 2026-07-15T18:00 JST。
    const cands = heatAlertCandidates(new Date("2026-07-15T09:00:00Z"));
    expect(cands).toEqual([
      { yyyy: "2026", yyyymmdd: "20260715", hour: "17" },
      { yyyy: "2026", yyyymmdd: "20260715", hour: "05" },
      { yyyy: "2026", yyyymmdd: "20260714", hour: "17" },
    ]);
  });

  it("now=JST 10:00 → 先頭は今日17（最新順の定義どおり今日17→今日05→昨日17）", () => {
    // 2026-07-15T01:00:00Z = 2026-07-15T10:00 JST。
    const cands = heatAlertCandidates(new Date("2026-07-15T01:00:00Z"));
    expect(cands[0]).toEqual({ yyyy: "2026", yyyymmdd: "20260715", hour: "17" });
    expect(cands[1]).toEqual({ yyyy: "2026", yyyymmdd: "20260715", hour: "05" });
    expect(cands[2]).toEqual({ yyyy: "2026", yyyymmdd: "20260714", hour: "17" });
  });

  it("now=JST 03:00 → 昨日へロールオーバーした yyyymmdd を末尾候補に含む", () => {
    // 2026-07-14T18:00:00Z = 2026-07-15T03:00 JST。今日=7/15, 昨日=7/14。
    const cands = heatAlertCandidates(new Date("2026-07-14T18:00:00Z"));
    expect(cands[0]?.yyyymmdd).toBe("20260715"); // 今日17（05 時前なので存在せず 404 想定だが候補としては先頭）
    expect(cands[2]).toEqual({ yyyy: "2026", yyyymmdd: "20260714", hour: "17" }); // 昨日17 が当たる想定
  });

  it("月初の JST 03:00 → 昨日が前月末日に正しくロールオーバーする（UTC+9 基準）", () => {
    // 2026-07-31T18:00:00Z = 2026-08-01T03:00 JST。今日=8/1, 昨日=7/31。
    const cands = heatAlertCandidates(new Date("2026-07-31T18:00:00Z"));
    expect(cands[0]?.yyyymmdd).toBe("20260801");
    expect(cands[2]?.yyyymmdd).toBe("20260731");
  });
});

describe("fetchHeatFromEnv", () => {
  const config = (fetchImpl: typeof fetch): HttpFetchConfig => ({
    userAgent: "test-ua/1.0",
    timeoutMs: 1000,
    fetchImpl,
  });

  const csvBody = [
    "府県予報区,a,b,府県予報区等コード,都道府県名,e,TargetDate1フラグ,TargetDate2フラグ,日最高WBGT（10:00）,日最高WBGT（17:00）,日最高WBGT（5:00）",
    "岐阜県,52,0,210000,岐阜,21,1,0,岐阜:33,,",
  ].join("\n");

  it("2xx の CSV を text で取得し該当地域行をパースする。明示 User-Agent を付ける。forecastDate は当日(JST)", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toContain("/alert/dl/");
      expect(String(url)).toContain("/alert_");
      expect((init?.headers as Record<string, string>)["User-Agent"]).toBe("test-ua/1.0");
      return new Response(csvBody, { status: 200 });
    }) as unknown as typeof fetch;
    const heat: FetchedHeat = await fetchHeatFromEnv("210000", config(fetchImpl));
    expect(heat.parsed.areaCode).toBe("210000");
    expect(heat.parsed.alertLevel).toBe("warning");
    expect(heat.parsed.wbgtMax).toBe(33);
    // forecastDate は JST 暦日（'YYYY-MM-DD'）。
    expect(heat.forecastDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("★ 公開時刻非依存: 今日17=404・今日05=200 なら今日05 を採用しパース成功（forecastDate=当日）", async () => {
    // 候補は最新順（今日17 → 今日05 → 昨日17）。1 件目を 404 にして 2 件目で 200 を返す。
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("_17.csv")) return new Response("not found", { status: 404 });
      if (u.includes("_05.csv")) return new Response(csvBody, { status: 200 });
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    const heat = await fetchHeatFromEnv("210000", config(fetchImpl));
    expect(heat.parsed.areaCode).toBe("210000");
    expect(heat.parsed.wbgtMax).toBe(33);
    expect(heat.forecastDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // 今日17(404) → 今日05(200) の 2 試行（昨日17 までは行かない）。
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("★ 全候補 404 なら throw（fail-soft / runWeatherFetch が地域単位で捕捉して他指標を巻き込まず skip）", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("not found", { status: 404 }),
    ) as unknown as typeof fetch;
    await expect(fetchHeatFromEnv("210000", config(fetchImpl))).rejects.toThrow(/取得失敗/);
    // 全候補（3 件）を試したうえで throw。
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("★ 最小試行: 1 件目（今日17）が 200 なら追加 fetch を呼ばない", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(csvBody, { status: 200 }),
    ) as unknown as typeof fetch;
    const heat = await fetchHeatFromEnv("210000", config(fetchImpl));
    expect(heat.parsed.wbgtMax).toBe(33);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// ADR-046: 大気質(PM2.5)/UV 相乗り（5 例目・最も脆いソース = そらまめくん）
// ============================================================================

function fakeAir(areaCode: string, forecastDate = "2026-07-15"): FetchedAir {
  const parsed: ParsedAirQuality = {
    areaCode,
    areaName: null,
    pm25: 18,
    pm25Band: "moderate",
    oxidant: null,
    uvIndex: null,
    uvBand: null,
    raw: { areaCode, areaName: null, pm25: 18, oxidant: null, stationCount: 1, pm25Samples: [18] },
  };
  return { parsed, forecastDate };
}

describe("runWeatherFetch（ADR-046 大気質相乗り）", () => {
  it("大気質 deps 指定時は天気・警報・熱中症と並走して大気質も取得・保存する", async () => {
    const savedAir: string[] = [];
    const summary = await runWeatherFetch({
      listAreaCodes: async () => ["210000", "130000"],
      fetchArea: async (areaCode) => ({ parsed: fakeParsed(areaCode), raw: {} }),
      saveArea: async (area) => area.parsed.days.length,
      fetchHeat: async (areaCode) => fakeHeat(areaCode),
      saveHeat: async () => {},
      fetchAir: async (areaCode) => fakeAir(areaCode),
      saveAir: async (areaCode) => {
        savedAir.push(areaCode);
      },
    });
    expect(summary.fetched).toBe(2);
    expect(summary.heatFetched).toBe(2);
    expect(summary.airFetched).toBe(2);
    expect(summary.airFailed).toBe(0);
    expect(summary.airFailedAreaCodes).toEqual([]);
    expect(savedAir).toEqual(["210000", "130000"]);
  });

  it("大気質 deps 未指定なら大気質は 0（既存の天気/警報/熱中症のみ呼び出しの後方互換）", async () => {
    const summary = await runWeatherFetch({
      listAreaCodes: async () => ["210000"],
      fetchArea: async (areaCode) => ({ parsed: fakeParsed(areaCode), raw: {} }),
      saveArea: async (area) => area.parsed.days.length,
    });
    expect(summary.airFetched).toBe(0);
    expect(summary.airFailed).toBe(0);
    expect(summary.airFailedAreaCodes).toEqual([]);
  });

  it("★ 大気質の取得失敗は天気・警報・熱中症を壊さない（その地域も他指標は保存される / fail-soft）", async () => {
    const summary = await runWeatherFetch({
      listAreaCodes: async () => ["210000"],
      fetchArea: async (areaCode) => ({ parsed: fakeParsed(areaCode), raw: {} }),
      saveArea: async (area) => area.parsed.days.length,
      fetchWarning: async (areaCode) => ({ parsed: fakeWarning(areaCode), raw: {} }),
      saveWarning: async () => {},
      fetchHeat: async (areaCode) => fakeHeat(areaCode),
      saveHeat: async () => {},
      fetchAir: async () => {
        throw new Error("soramame 404");
      },
      saveAir: async () => {
        /* 呼ばれない */
      },
    });
    // 天気・警報・熱中症は成功（大気質の失敗に巻き込まれない）。
    expect(summary.fetched).toBe(1);
    expect(summary.warningsFetched).toBe(1);
    expect(summary.heatFetched).toBe(1);
    // 大気質のみその地域を skip。
    expect(summary.airFetched).toBe(0);
    expect(summary.airFailed).toBe(1);
    expect(summary.airFailedAreaCodes).toEqual(["210000"]);
  });

  it("大気質の保存(upsert)失敗もその地域だけ skip する", async () => {
    const summary = await runWeatherFetch({
      listAreaCodes: async () => ["210000"],
      fetchArea: async (areaCode) => ({ parsed: fakeParsed(areaCode), raw: {} }),
      saveArea: async (area) => area.parsed.days.length,
      fetchAir: async (areaCode) => fakeAir(areaCode),
      saveAir: async () => {
        throw new Error("DB error");
      },
    });
    expect(summary.fetched).toBe(1);
    expect(summary.airFetched).toBe(0);
    expect(summary.airFailed).toBe(1);
    expect(summary.airFailedAreaCodes).toEqual(["210000"]);
  });
});

describe("soramameAirMetadataUrl / soramameNoudoAllUrl", () => {
  it("鮮度メタ URL は固定（noudoAll/metadata.json）", () => {
    expect(soramameAirMetadataUrl()).toBe(
      "https://soramame.env.go.jp/data/sokutei/noudoAll/metadata.json",
    );
  });
  it("全国 1 時間値 CSV URL を {YYYY}/{MM}/{DD}/{HH}.csv 形式で組む（SPA rule と一致）", () => {
    expect(soramameNoudoAllUrl("2026", "06", "19", "09")).toBe(
      "https://soramame.env.go.jp/data/sokutei/noudoAll/2026/06/19/09.csv",
    );
  });
});

describe("parseSoramameLatest", () => {
  it("'YYYY/MM/DD HH:00:00' を日付次元に分解する", () => {
    expect(parseSoramameLatest("2026/06/19 09:00:00")).toEqual({
      yyyy: "2026",
      mm: "06",
      dd: "19",
      hh: "09",
    });
  });
  it("形式不一致 / 非文字列は null（呼び出し側が取得を諦めて fail-soft）", () => {
    expect(parseSoramameLatest("not a date")).toBeNull();
    expect(parseSoramameLatest(undefined)).toBeNull();
    expect(parseSoramameLatest(123)).toBeNull();
    expect(parseSoramameLatest("2026-06-19T09:00")).toBeNull();
  });
});

describe("fetchAirFromEnv", () => {
  const config = (fetchImpl: typeof fetch): HttpFetchConfig => ({
    userAgent: "test-ua/1.0",
    timeoutMs: 1000,
    fetchImpl,
  });

  // そらまめくん全国 CSV のヘッダ（実レスポンス）+ 岐阜（21）の代表 2 局（PM2.5 10/9）。
  const CSV_HEADER =
    "測定局コード,SO2,NO,NO2,NOX,CO,OX,NMHC,CH4,THC,SPM,PM2.5,SP,WD,WS,TEMP,HUM,測定局名称,住所,問い合わせ先,局種別,地域コード,都道府県コード,市区町村名";
  const CSV_BODY = [
    CSV_HEADER,
    "21201010,0,0,0,0,  ,0,  ,  ,  ,0.010,10,  ,  ,  ,  ,  ,岐阜中央,住所,岐阜市,一般局,4,21,岐阜市",
    "21201020,0,0,0,0,  ,0,  ,  ,  ,0.013,9,  ,  ,  ,  ,  ,岐阜南部,住所,岐阜市,一般局,4,21,岐阜市",
  ].join("\n");

  it("metadata → 全国 CSV を取得し府県中央値をパースする。明示 User-Agent。forecastDate は当日(JST)", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      seen.push(u);
      expect(u).toContain("soramame.env.go.jp");
      expect((init?.headers as Record<string, string>)["User-Agent"]).toBe("test-ua/1.0");
      if (u.endsWith("metadata.json")) {
        return new Response(JSON.stringify({ latest: "2026/06/19 09:00:00", interval: "3600" }), {
          status: 200,
        });
      }
      return new Response(CSV_BODY, { status: 200 });
    }) as unknown as typeof fetch;
    const air: FetchedAir = await fetchAirFromEnv("210000", config(fetchImpl));
    expect(air.parsed.areaCode).toBe("210000");
    // PM2.5 10 / 9 → 中央値（下側中央）= 9。
    expect(air.parsed.pm25).toBe(9);
    expect(air.parsed.pm25Band).toBe("good"); // < 12
    // UV は本 PR 未取得（常に null）。
    expect(air.parsed.uvIndex).toBeNull();
    expect(air.forecastDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // metadata → CSV の順で 2 本叩き、CSV URL は latest 時刻で組む。
    expect(seen[0]).toBe("https://soramame.env.go.jp/data/sokutei/noudoAll/metadata.json");
    expect(seen[1]).toBe("https://soramame.env.go.jp/data/sokutei/noudoAll/2026/06/19/09.csv");
  });

  it("metadata が非 2xx は throw（runWeatherFetch が地域単位で捕捉して他指標を巻き込まず skip）", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("not found", { status: 404 }),
    ) as unknown as typeof fetch;
    await expect(fetchAirFromEnv("210000", config(fetchImpl))).rejects.toThrow(/status=404/);
  });

  it("metadata の latest が想定外形式は throw（latest 解析不能）", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ latest: "garbage" }), { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(fetchAirFromEnv("210000", config(fetchImpl))).rejects.toThrow(/latest 解析不能/);
  });

  it("CSV が非 2xx は throw（その地域の大気質だけ skip）", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("metadata.json")) {
        return new Response(JSON.stringify({ latest: "2026/06/19 09:00:00" }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    await expect(fetchAirFromEnv("210000", config(fetchImpl))).rejects.toThrow(/CSV 取得失敗.*404/);
  });
});

// ============================================================================
// ADR-045: per-school 学校行事カレンダー（公開 iCal）相乗りフェーズ
// ============================================================================

function fakeSource(id: string, schoolId: string): EnabledCalendarSource {
  return { id, schoolId, icsUrl: `https://example.test/${id}.ics` };
}

function fakeCalEvent(startDate: string, summary = "始業式"): ParsedCalendarEvent {
  return {
    uid: `uid-${startDate}`,
    summary,
    startDate,
    endDate: null,
    startAt: null,
    endAt: null,
    allDay: true,
    location: null,
    raw: {},
  };
}

describe("runWeatherFetch（ADR-045 学校カレンダー相乗り）", () => {
  it("カレンダー deps 指定時は天気の後に per-school で取得・保存する", async () => {
    const saved: string[] = [];
    const recorded: Array<{ id: string; ok: boolean }> = [];
    const summary = await runWeatherFetch({
      listAreaCodes: async () => ["210000"],
      fetchArea: async (areaCode) => ({ parsed: fakeParsed(areaCode), raw: {} }),
      saveArea: async (area) => area.parsed.days.length,
      listCalendarSources: async () => [
        fakeSource("src-a", "school-a"),
        fakeSource("src-b", "school-b"),
      ],
      fetchCalendar: async (source) => ({
        source,
        events: [fakeCalEvent("2026-04-08"), fakeCalEvent("2026-04-09")],
      }),
      saveCalendar: async (fetched) => {
        saved.push(fetched.source.id);
        return fetched.events.length;
      },
      recordCalendarResult: async (id, result) => {
        recorded.push({ id, ok: result.ok });
      },
    });
    expect(summary.fetched).toBe(1);
    expect(summary.calendarSources).toBe(2);
    expect(summary.calendarFetched).toBe(2);
    expect(summary.calendarRowsUpserted).toBe(4);
    expect(summary.calendarFailed).toBe(0);
    expect(summary.calendarFailedSourceIds).toEqual([]);
    expect(saved).toEqual(["src-a", "src-b"]);
    // 成功は ok=true を記録。
    expect(recorded).toEqual([
      { id: "src-a", ok: true },
      { id: "src-b", ok: true },
    ]);
  });

  it("★ 1 校の取得失敗は他校・天気を壊さない（その校だけ skip / fail-soft）", async () => {
    const recorded: Array<{ id: string; ok: boolean }> = [];
    const summary = await runWeatherFetch({
      listAreaCodes: async () => ["210000"],
      fetchArea: async (areaCode) => ({ parsed: fakeParsed(areaCode), raw: {} }),
      saveArea: async (area) => area.parsed.days.length,
      listCalendarSources: async () => [
        fakeSource("src-a", "school-a"),
        fakeSource("src-bad", "school-b"),
        fakeSource("src-c", "school-c"),
      ],
      fetchCalendar: async (source) => {
        if (source.id === "src-bad") throw new Error("iCal 404");
        return { source, events: [fakeCalEvent("2026-04-08")] };
      },
      saveCalendar: async (fetched) => fetched.events.length,
      recordCalendarResult: async (id, result) => {
        recorded.push({ id, ok: result.ok });
      },
    });
    // 天気は無傷。
    expect(summary.fetched).toBe(1);
    expect(summary.failed).toBe(0);
    // 失敗校だけ skip、他 2 校は前進。
    expect(summary.calendarSources).toBe(3);
    expect(summary.calendarFetched).toBe(2);
    expect(summary.calendarRowsUpserted).toBe(2);
    expect(summary.calendarFailed).toBe(1);
    expect(summary.calendarFailedSourceIds).toEqual(["src-bad"]);
    // 失敗校は ok=false（理由付き）を記録、成功校は ok=true。
    expect(recorded).toEqual([
      { id: "src-a", ok: true },
      { id: "src-bad", ok: false },
      { id: "src-c", ok: true },
    ]);
  });

  it("★ カレンダーの保存(upsert)失敗もその校だけ skip する", async () => {
    const summary = await runWeatherFetch({
      listAreaCodes: async () => [],
      fetchArea: async () => ({ parsed: fakeParsed("x"), raw: {} }),
      saveArea: async () => 1,
      listCalendarSources: async () => [fakeSource("src-a", "school-a")],
      fetchCalendar: async (source) => ({ source, events: [fakeCalEvent("2026-04-08")] }),
      saveCalendar: async () => {
        throw new Error("DB error");
      },
    });
    expect(summary.calendarSources).toBe(1);
    expect(summary.calendarFetched).toBe(0);
    expect(summary.calendarFailed).toBe(1);
    expect(summary.calendarFailedSourceIds).toEqual(["src-a"]);
  });

  it("ソース列挙自体の失敗は per-school 成果ゼロで続行し天気を壊さない", async () => {
    const summary = await runWeatherFetch({
      listAreaCodes: async () => ["210000"],
      fetchArea: async (areaCode) => ({ parsed: fakeParsed(areaCode), raw: {} }),
      saveArea: async (area) => area.parsed.days.length,
      listCalendarSources: async () => {
        throw new Error("DB list error");
      },
      fetchCalendar: async (source) => ({ source, events: [] }),
      saveCalendar: async () => 0,
    });
    expect(summary.fetched).toBe(1);
    expect(summary.calendarSources).toBe(0);
    expect(summary.calendarFetched).toBe(0);
    expect(summary.calendarFailed).toBe(0);
  });

  it("カレンダー deps が一部欠ける（listのみ）ならフェーズは走らない（後方互換）", async () => {
    const summary = await runWeatherFetch({
      listAreaCodes: async () => [],
      fetchArea: async () => ({ parsed: fakeParsed("x"), raw: {} }),
      saveArea: async () => 1,
      // fetchCalendar / saveCalendar を渡さない。
      listCalendarSources: async () => [fakeSource("src-a", "school-a")],
    });
    expect(summary.calendarSources).toBe(0);
    expect(summary.calendarFetched).toBe(0);
  });
});

describe("stableEventUid", () => {
  it("iCal UID があればそのまま使う", () => {
    expect(stableEventUid("src-a", fakeCalEvent("2026-04-08"))).toBe("uid-2026-04-08");
  });

  it("UID 欠落は (source,startDate,summary) から決定論的に生成（再取得で同一 = 冪等）", () => {
    const ev: ParsedCalendarEvent = { ...fakeCalEvent("2026-04-08"), uid: null };
    const a = stableEventUid("src-a", ev);
    const b = stableEventUid("src-a", { ...ev });
    expect(a).toBe(b);
    expect(a).toMatch(/^gen-[0-9a-f]{32}$/);
    // 別ソース / 別日付なら別キー。
    expect(stableEventUid("src-b", ev)).not.toBe(a);
    expect(stableEventUid("src-a", { ...ev, startDate: "2026-04-09" })).not.toBe(a);
  });

  it("★ ADR-049 決定 2: 外部フィードの UID が file: で始まる場合は ical: を前置してリライト（名前空間侵食防止）", () => {
    const ev: ParsedCalendarEvent = { ...fakeCalEvent("2026-04-08"), uid: "file:evil:1" };
    const rewritten = stableEventUid("src-a", ev);
    expect(rewritten).toBe("ical:file:evil:1");
    // 決定的（再取得でも同一 uid → upsert 冪等・keepUids も同じ値で整合する。uid 導出は本関数の単一点）。
    expect(stableEventUid("src-a", { ...ev })).toBe(rewritten);
    // file: 以外の通常 uid はリライトされない。
    expect(stableEventUid("src-a", fakeCalEvent("2026-04-08"))).toBe("uid-2026-04-08");
  });
});

describe("fetchIcs", () => {
  // ADR-045 §SSRF: fetchIcs は SSRF セーフな fetchPublicIcs 経由になったため、ホスト名解決を公開 IP に倒す
  // resolver を注入する（実 DNS 非依存）。SSRF ガード自体の網羅は calendar/__tests__/safe-fetch.test.ts。
  const publicResolver = async () => [{ address: "93.184.216.34", family: 4 }];
  const config = (fetchImpl: typeof fetch): HttpFetchConfig => ({
    userAgent: "test-ua/1.0",
    timeoutMs: 1000,
    fetchImpl,
    icsResolver: publicResolver,
  });

  it("2xx の iCal をパースする。明示 User-Agent を付ける", async () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:evt-1",
      "SUMMARY:始業式",
      "DTSTART;VALUE=DATE:20260408",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://example.test/src-a.ics");
      expect((init?.headers as Record<string, string>)["User-Agent"]).toBe("test-ua/1.0");
      return new Response(ics, { status: 200 });
    }) as unknown as typeof fetch;
    const result: FetchedCalendar = await fetchIcs(
      fakeSource("src-a", "school-a"),
      config(fetchImpl),
    );
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.summary).toBe("始業式");
    expect(result.events[0]?.allDay).toBe(true);
  });

  it("非 2xx は throw する（status のみ・URL を漏らさない）", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("nope", { status: 403 }),
    ) as unknown as typeof fetch;
    await expect(fetchIcs(fakeSource("src-a", "school-a"), config(fetchImpl))).rejects.toThrow(
      /status=403/,
    );
  });

  it("★ SSRF: http scheme の icsUrl は fetch 前に拒否する", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("x", { status: 200 }),
    ) as unknown as typeof fetch;
    const source: EnabledCalendarSource = {
      id: "src-http",
      schoolId: "school-a",
      icsUrl: "http://example.test/x.ics",
    };
    await expect(fetchIcs(source, config(fetchImpl))).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("★ SSRF: メタデータ IP 直指定の icsUrl は fetch 前に拒否する", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("x", { status: 200 }),
    ) as unknown as typeof fetch;
    const source: EnabledCalendarSource = {
      id: "src-meta",
      schoolId: "school-a",
      icsUrl: "https://169.254.169.254/computeMetadata/v1/",
    };
    await expect(fetchIcs(source, config(fetchImpl))).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("★ 取込上限: MAX_EVENTS_PER_SOURCE 超過は切り捨て、何件落としたか WARN を出す", async () => {
    // MAX_EVENTS_PER_SOURCE + 5 件の VEVENT を持つ巨大 iCal を生成。
    const over = MAX_EVENTS_PER_SOURCE + 5;
    const blocks: string[] = ["BEGIN:VCALENDAR"];
    for (let i = 0; i < over; i++) {
      blocks.push("BEGIN:VEVENT", `UID:evt-${i}`, "DTSTART;VALUE=DATE:20260408", "END:VEVENT");
    }
    blocks.push("END:VCALENDAR");
    const ics = blocks.join("\r\n");
    const fetchImpl = vi.fn(
      async () => new Response(ics, { status: 200 }),
    ) as unknown as typeof fetch;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await fetchIcs(fakeSource("src-big", "school-a"), config(fetchImpl));
      expect(result.events).toHaveLength(MAX_EVENTS_PER_SOURCE);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const logged = JSON.parse(String(warnSpy.mock.calls[0]?.[0]));
      expect(logged.event).toBe("calendar.ingest.truncated");
      expect(logged.sourceId).toBe("src-big");
      expect(logged.dropped).toBe(5);
      expect(logged.kept).toBe(MAX_EVENTS_PER_SOURCE);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
