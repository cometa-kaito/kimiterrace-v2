import { describe, expect, it } from "vitest";
import { heatFlagToLevel, parseEnvHeatAlert, wbgtToBand } from "../env-heat.js";

/**
 * ADR-044: 環境省 alert CSV の純粋パースを fixture で検証する（ネットワーク非依存）。
 *
 * fixture は環境省「熱中症予防情報サイト」`alert_{YYYYMMDD}_{HH}.csv`（全国 1 ファイル）の構造を縮約したもの。
 * 実 CSV のフォーマット変化に対する防御（欠損で落とさない・null/none 化）と、アラート段階導出（フラグ
 * 0/1/2/3/9 → none/warning/none/emergency/none）・WBGT 区分導出も検証する。
 * 実 PG / RLS の振る舞いは packages/db の heat-alerts.test.ts（実 PG）でカバーする。
 */

// 確認済の環境省 alert CSV 構造を縮約した fixture（ヘッダ + メタ行 + 複数県のデータ行）。
const CSV_FIXTURE = [
  "Title,熱中症特別警戒情報・熱中症警戒情報,,,,,,,,,",
  "CreateDate,2026/07/15,,,,,,,,,",
  "ReportDate,2026/07/15,,,,,,,,,",
  "FlagExplanation,発表無し:0、熱中症警戒情報発表:1、熱中症特別警戒情報判定:2、熱中症特別警戒情報発表:3、発表時間外:9,,,,,,,,,",
  "府県予報区,都府県・振興局表示番号,都府県・振興局表示番号サブ,府県予報区等コード,都道府県名,都道府県コード,TargetDate1フラグ,TargetDate2フラグ,日最高WBGT（10:00）,日最高WBGT（17:00）,日最高WBGT（5:00）",
  // 岐阜県: 当日フラグ 1（警戒アラート）、WBGT 地点別ピーク 33（高山:31/岐阜:33/多治見:32）。
  "岐阜県,52,0,210000,岐阜,21,1,0,高山:31/岐阜:33/多治見:32,,",
  // 東京都: 当日フラグ 3（特別警戒アラート）、WBGT 35。
  "東京都,44,0,130000,東京,13,3,1,東京:35/八王子:34,,",
  // 大阪府: 当日フラグ 0（発表無し）、WBGT 27（=警戒区分）。
  "大阪府,62,0,270000,大阪,27,0,0,大阪:27/堺:26,,",
  // 愛知県: 当日フラグ 2（特別警戒判定のみ・未発表 → none に倒す）、WBGT 列空。
  "愛知県,51,0,230000,愛知,23,2,0,,,",
].join("\n");

describe("heatFlagToLevel", () => {
  it("環境省フラグを段階に正規化する（1=警戒 / 3=特別警戒 / その他=none）", () => {
    expect(heatFlagToLevel("0")).toBe("none");
    expect(heatFlagToLevel("1")).toBe("warning");
    expect(heatFlagToLevel("2")).toBe("none"); // 判定のみ・未発表
    expect(heatFlagToLevel("3")).toBe("emergency");
    expect(heatFlagToLevel("9")).toBe("none"); // 発表時間外
    expect(heatFlagToLevel(" 1 ")).toBe("warning"); // 前後空白
    expect(heatFlagToLevel("99")).toBe("none"); // 未知
    expect(heatFlagToLevel(null)).toBe("none");
  });
});

describe("wbgtToBand", () => {
  it("WBGT 値を 5 区分に分類する（境界含む）", () => {
    expect(wbgtToBand(20)).toBe("almost_safe"); // < 21
    expect(wbgtToBand(21)).toBe("caution"); // 21..<25
    expect(wbgtToBand(24)).toBe("caution");
    expect(wbgtToBand(25)).toBe("warning"); // 25..<28
    expect(wbgtToBand(27)).toBe("warning");
    expect(wbgtToBand(28)).toBe("severe"); // 28..<31
    expect(wbgtToBand(30)).toBe("severe");
    expect(wbgtToBand(31)).toBe("danger"); // >=31
    expect(wbgtToBand(37)).toBe("danger");
  });
  it("null / 非有限は null（区分なし）に倒す", () => {
    expect(wbgtToBand(null)).toBeNull();
    expect(wbgtToBand(Number.NaN)).toBeNull();
  });
});

describe("parseEnvHeatAlert", () => {
  it("警戒アラート（フラグ 1）: alertLevel=warning, WBGT ピーク=33 → danger", () => {
    const out = parseEnvHeatAlert("210000", CSV_FIXTURE);
    expect(out.areaCode).toBe("210000");
    expect(out.areaName).toBe("岐阜県");
    expect(out.alertLevel).toBe("warning");
    expect(out.wbgtMax).toBe(33); // 高山:31/岐阜:33/多治見:32 のピーク
    expect(out.wbgtBand).toBe("danger"); // 33 >= 31
    expect(out.raw.targetDate1Flag).toBe("1");
    expect(out.raw.prefName).toBe("岐阜");
  });

  it("特別警戒アラート（フラグ 3）: alertLevel=emergency, WBGT ピーク=35 → danger", () => {
    const out = parseEnvHeatAlert("130000", CSV_FIXTURE);
    expect(out.alertLevel).toBe("emergency");
    expect(out.wbgtMax).toBe(35);
    expect(out.wbgtBand).toBe("danger");
  });

  it("発表無し（フラグ 0）: alertLevel=none, WBGT 27 → 区分は warning（暑さ指数は段階と独立）", () => {
    const out = parseEnvHeatAlert("270000", CSV_FIXTURE);
    expect(out.alertLevel).toBe("none");
    expect(out.wbgtMax).toBe(27);
    expect(out.wbgtBand).toBe("warning"); // 25..<28
  });

  it("特別警戒判定のみ（フラグ 2・未発表）: alertLevel=none、WBGT 列空 → wbgt は null（fail-soft）", () => {
    const out = parseEnvHeatAlert("230000", CSV_FIXTURE);
    expect(out.alertLevel).toBe("none");
    expect(out.wbgtMax).toBeNull();
    expect(out.wbgtBand).toBeNull();
  });

  it("該当地域行が無い: 安全な既定（none / null）を返す（last-known-good を壊さない）", () => {
    const out = parseEnvHeatAlert("999999", CSV_FIXTURE);
    expect(out.areaCode).toBe("999999");
    expect(out.areaName).toBeNull();
    expect(out.alertLevel).toBe("none");
    expect(out.wbgtMax).toBeNull();
    expect(out.wbgtBand).toBeNull();
  });

  it("壊れた / 空 CSV: throw せず none / null に倒す（fail-soft）", () => {
    for (const broken of [null, undefined, 42, "", [], {}, "garbage,no,header"]) {
      const out = parseEnvHeatAlert("210000", broken);
      expect(out.areaCode).toBe("210000");
      expect(out.alertLevel).toBe("none");
      expect(out.wbgtMax).toBeNull();
      expect(out.wbgtBand).toBeNull();
    }
  });

  it("WBGT は 10:00 列が空なら 17:00 → 5:00 へフォールバックする", () => {
    const csv = [
      "府県予報区,a,b,府県予報区等コード,都道府県名,e,TargetDate1フラグ,TargetDate2フラグ,日最高WBGT（10:00）,日最高WBGT（17:00）,日最高WBGT（5:00）",
      // 10:00 列は空、17:00 に 29。
      "岐阜県,52,0,210000,岐阜,21,1,0,,岐阜:29,",
    ].join("\n");
    const out = parseEnvHeatAlert("210000", csv);
    expect(out.wbgtMax).toBe(29);
    expect(out.wbgtBand).toBe("severe"); // 28..<31
  });
});
