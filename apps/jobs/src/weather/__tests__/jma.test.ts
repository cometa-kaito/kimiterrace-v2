import { describe, expect, it } from "vitest";
import { parseJmaForecast, parseNumeric, toJstDateString } from "../jma.js";

/**
 * F14 (#128, ADR-021): JMA forecast JSON の純粋パースを fixture で検証する（ネットワーク非依存）。
 *
 * fixture は気象庁 bosai `forecast/{areaCode}.json` の構造を縮約したもの（近日 3 日 + 週間）。
 * 実 API のフォーマット変化に対する防御（欠損で落とさない・null 化）も合わせて検証する。
 */

/** 岐阜県（210000）相当の縮約 fixture。 */
const FIXTURE = [
  {
    timeSeries: [
      {
        timeDefines: ["2026-06-02T00:00:00+09:00", "2026-06-03T00:00:00+09:00"],
        areas: [
          {
            area: { name: "美濃地方", code: "210010" },
            weatherCodes: ["100", "200"],
            weathers: ["晴れ", "くもり　時々　雨"],
          },
        ],
      },
      {
        timeDefines: [
          "2026-06-02T06:00:00+09:00",
          "2026-06-02T12:00:00+09:00",
          "2026-06-03T06:00:00+09:00",
        ],
        areas: [{ area: { name: "美濃地方", code: "210010" }, pops: ["10", "30", "60"] }],
      },
      {
        timeDefines: ["2026-06-02T09:00:00+09:00", "2026-06-02T00:00:00+09:00"],
        areas: [{ area: { name: "岐阜", code: "52206" }, temps: ["28", "18"] }],
      },
    ],
  },
  {
    timeSeries: [
      {
        timeDefines: ["2026-06-03T00:00:00+09:00", "2026-06-04T00:00:00+09:00"],
        areas: [
          {
            area: { name: "岐阜県", code: "210000" },
            weatherCodes: ["201", "300"],
            pops: ["", "70"],
          },
        ],
      },
      {
        timeDefines: ["2026-06-03T00:00:00+09:00", "2026-06-04T00:00:00+09:00"],
        areas: [
          { area: { name: "岐阜", code: "52206" }, tempsMin: ["", "20"], tempsMax: ["", "25"] },
        ],
      },
    ],
  },
];

describe("toJstDateString", () => {
  it("ISO 文字列の先頭日付を JST 暦日として取り出す（TZ 変換しない）", () => {
    expect(toJstDateString("2026-06-02T00:00:00+09:00")).toBe("2026-06-02");
    expect(toJstDateString("2026-12-31T23:00:00+09:00")).toBe("2026-12-31");
  });
  it("非文字列・空・不正形は null", () => {
    expect(toJstDateString(null)).toBeNull();
    expect(toJstDateString("")).toBeNull();
    expect(toJstDateString(123)).toBeNull();
    expect(toJstDateString("2026/06/02")).toBeNull();
  });
});

describe("parseNumeric", () => {
  it("数値・数値文字列を数値化、空/ハイフン/不能は null", () => {
    expect(parseNumeric(28)).toBe(28);
    expect(parseNumeric("30")).toBe(30);
    expect(parseNumeric(" 12 ")).toBe(12);
    expect(parseNumeric("")).toBeNull();
    expect(parseNumeric("-")).toBeNull();
    expect(parseNumeric("abc")).toBeNull();
    expect(parseNumeric(null)).toBeNull();
    expect(parseNumeric(Number.NaN)).toBeNull();
  });
});

describe("parseJmaForecast", () => {
  it("地域名・天気コード・テキスト・降水確率・気温を日付でマージする", () => {
    const parsed = parseJmaForecast("210000", FIXTURE);
    expect(parsed.areaCode).toBe("210000");
    expect(parsed.areaName).toBe("美濃地方");

    const byDate = new Map(parsed.days.map((d) => [d.forecastDate, d]));

    // 6/2: near の天気「晴れ」、pop は時間帯別の最大(10,30)=30、気温 min/max=18/28。
    const d2 = byDate.get("2026-06-02");
    expect(d2?.weatherCode).toBe("100");
    expect(d2?.weatherText).toBe("晴れ");
    expect(d2?.pop).toBe(30);
    expect(d2?.tempMin).toBe(18);
    expect(d2?.tempMax).toBe(28);

    // 6/3: near 天気「くもり時々雨」(全角空白除去)、near pop=60（週間より near 優先）。
    const d3 = byDate.get("2026-06-03");
    expect(d3?.weatherCode).toBe("200");
    expect(d3?.weatherText).toBe("くもり時々雨");
    expect(d3?.pop).toBe(60);

    // 6/4: near に無く週間のみ → 週間天気コード 300・pop70・気温 20/25 を補完。
    const d4 = byDate.get("2026-06-04");
    expect(d4?.weatherCode).toBe("300");
    expect(d4?.pop).toBe(70);
    expect(d4?.tempMin).toBe(20);
    expect(d4?.tempMax).toBe(25);
  });

  it("週間は near でカバー済の日を上書きしない（near 優先）", () => {
    const parsed = parseJmaForecast("210000", FIXTURE);
    const d3 = parsed.days.find((d) => d.forecastDate === "2026-06-03");
    // 週間側は 6/3 に weatherCodes[0]='201' を持つが near の '200' が優先される。
    expect(d3?.weatherCode).toBe("200");
  });

  it("空配列・null・壊れた構造でも throw せず days=[] を返す（防御的）", () => {
    expect(parseJmaForecast("210000", null).days).toEqual([]);
    expect(parseJmaForecast("210000", []).days).toEqual([]);
    expect(parseJmaForecast("210000", [{ timeSeries: "broken" }]).days).toEqual([]);
    expect(parseJmaForecast("210000", [{}]).days).toEqual([]);
  });
});
