import { describe, expect, it } from "vitest";
import { parseSoramameNoudoAllCsv, pm25ToBand } from "../env-air.js";

/**
 * ADR-046: そらまめくん全国 1 時間値 CSV（全測定局 1 ファイル）の純粋パースを fixture で検証する（ネットワーク非依存）。
 *
 * fixture は **2026-06-19 09:00 の実レスポンス**から抜粋した代表行（岐阜 '21' / 東京 '13' / 欠測セル / 自排局）。
 * 本テストは PM2.5 の府県フィルタ + 中央値集計、欠測（空白セル / '-'）の防御、列ずれ・HTML fallback への fail-soft、
 * PM2.5 区分導出、UV / オキシダント非取得（常に null）を固定する。実 PG / RLS の振る舞いは packages/db の
 * air-quality.test.ts（実 PG）でカバーする。
 */

// そらまめくん全国 CSV のヘッダ（実レスポンス、確認済 2026-06-19）。
const HEADER =
  "測定局コード,SO2,NO,NO2,NOX,CO,OX,NMHC,CH4,THC,SPM,PM2.5,SP,WD,WS,TEMP,HUM,測定局名称,住所,問い合わせ先,局種別,地域コード,都道府県コード,市区町村名";

// 実レスポンスから抜粋した代表行（岐阜 PM2.5=10/9/9 + 欠測 2 行、東京 PM2.5=8/15）。
const GIFU_ROWS = [
  "21201010,0,0.001,0.004,0.005,  ,0.024,  ,  ,  ,0.010,10,  ,南,0.9,  ,  ,岐阜中央,岐阜市八ツ寺町1-7,岐阜市,一般局,4,21,岐阜市",
  "21201020,0,0,0.003,0.003,  ,0.035,0.06,1.97,2.03,0.013,9,  ,  ,  ,  ,  ,岐阜南部,岐阜市茜部菱野２－１１５～１１８,岐阜市,一般局,4,21,岐阜市",
  "21201030,0,-,-,-,  ,0.030,  ,  ,  ,0.009,9,  ,  ,  ,  ,  ,岐阜北部,岐阜市福光東３－１９,岐阜市,一般局,4,21,岐阜市",
  // 欠測（PM2.5 セルが空白のみ）の自排局・一般局 — 集計対象に含めない。
  "21201520,  ,0.006,0.006,0.012,0.2,  ,  ,  ,  ,0.010,  ,  ,  ,  ,  ,  ,明徳自動車排ガス,岐阜市明徳町１１,岐阜市,自排局,4,21,岐阜市",
  "21202010,0.002,  ,  ,  ,  ,  ,  ,  ,  ,0.011,  ,  ,  ,  ,  ,  ,大垣西部,大垣市綾野１－２７１９－１,大垣市,一般局,4,21,大垣市",
];
const TOKYO_ROWS = [
  "13101010,0.001,0.011,0.021,0.032,  ,0.020,  ,  ,  ,0.008,8,  ,西北西,0.6,27,66,千代田区神田司町,千代田区神田司町２丁目２番地,東京都,一般局,3,13,千代田区",
  "13101510,  ,0.021,0.029,0.050,0.5,  ,  ,  ,  ,0.019,15,  ,  ,  ,  ,  ,日比谷交差点,千代田区日比谷公園,東京都,自排局,3,13,千代田区",
];
const FULL_CSV = [HEADER, ...GIFU_ROWS, ...TOKYO_ROWS].join("\n");

describe("pm25ToBand", () => {
  it("PM2.5 値を 4 区分に分類する（境界含む）", () => {
    expect(pm25ToBand(0)).toBe("good"); // < 12
    expect(pm25ToBand(11)).toBe("good");
    expect(pm25ToBand(12)).toBe("moderate"); // 12..<35
    expect(pm25ToBand(34)).toBe("moderate");
    expect(pm25ToBand(35)).toBe("unhealthy"); // 35..<70
    expect(pm25ToBand(69)).toBe("unhealthy");
    expect(pm25ToBand(70)).toBe("hazardous"); // >=70
    expect(pm25ToBand(150)).toBe("hazardous");
  });
  it("null / 非有限 / 負値は null（区分なし）に倒す", () => {
    expect(pm25ToBand(null)).toBeNull();
    expect(pm25ToBand(Number.NaN)).toBeNull();
    expect(pm25ToBand(Number.POSITIVE_INFINITY)).toBeNull();
    expect(pm25ToBand(-5)).toBeNull();
  });
});

describe("parseSoramameNoudoAllCsv", () => {
  it("実 CSV: 岐阜 '210000' を都道府県コード '21' でフィルタし PM2.5 を中央値に畳む（10/9/9 → 9）", () => {
    const out = parseSoramameNoudoAllCsv("210000", FULL_CSV);
    expect(out.areaCode).toBe("210000");
    // PM2.5 を持つ岐阜の局は 10 / 9 / 9（欠測 2 局は除外）。中央値 = 9。
    expect(out.pm25).toBe(9);
    expect(out.pm25Band).toBe("good"); // < 12
    // オキシダント / UV は本 PR 未取得（常に null）。
    expect(out.oxidant).toBeNull();
    expect(out.uvIndex).toBeNull();
    expect(out.uvBand).toBeNull();
    // raw に集計サンプル（PM2.5 値・局数）を保全（PII 非格納の公開値のみ）。
    expect(out.raw.stationCount).toBe(3);
    expect([...out.raw.pm25Samples].sort((a, b) => a - b)).toEqual([9, 9, 10]);
  });

  it("実 CSV: 東京 '130000' は同じファイルから '13' でフィルタ（8/15 → 中央値 8 = 下側中央）", () => {
    const out = parseSoramameNoudoAllCsv("130000", FULL_CSV);
    // 偶数個（8,15）は下側中央（小さい方）= 8 を採る（外れ値に頑健）。
    expect(out.pm25).toBe(8);
    expect(out.pm25Band).toBe("good");
    expect(out.raw.stationCount).toBe(2);
  });

  it("該当府県の観測局が無い: 全 null（fail-soft / last-known-good を壊さない）", () => {
    // '270000'（大阪）は fixture に行が無い。
    const out = parseSoramameNoudoAllCsv("270000", FULL_CSV);
    expect(out.pm25).toBeNull();
    expect(out.pm25Band).toBeNull();
    expect(out.raw.stationCount).toBe(0);
    expect(out.raw.pm25Samples).toEqual([]);
  });

  it("府県内が全て欠測（PM2.5 空白 / '-'）: pm25 / band は null（fail-soft）", () => {
    const csv = [
      HEADER,
      // 都道府県 '40'（福岡）2 局: いずれも PM2.5 セルが欠測。
      "40101010,0.001,  ,  ,  ,  ,  ,  ,  ,  ,0.010,  ,  ,  ,  ,  ,  ,局A,住所A,問A,一般局,9,40,市A",
      "40101020,  ,  ,  ,  ,  ,  ,  ,  ,  ,  ,-,  ,  ,  ,  ,  ,局B,住所B,問B,一般局,9,40,市B",
    ].join("\n");
    const out = parseSoramameNoudoAllCsv("400000", csv);
    expect(out.pm25).toBeNull();
    expect(out.pm25Band).toBeNull();
    expect(out.raw.stationCount).toBe(0);
  });

  it("単一局でも採れる（中央値 = その値）。少数表記は切り捨て", () => {
    const csv = [
      HEADER,
      "21201010,0,0.001,0.004,0.005,  ,0.024,  ,  ,  ,0.010,33.7,  ,  ,  ,  ,  ,局,住所,問,一般局,4,21,市",
    ].join("\n");
    const out = parseSoramameNoudoAllCsv("210000", csv);
    expect(out.pm25).toBe(33); // 33.7 → 切り捨て
    expect(out.pm25Band).toBe("moderate"); // 12..<35
    expect(out.raw.stationCount).toBe(1);
  });

  it("負値の PM2.5（異常値）は集計から除外（fail-soft）", () => {
    const csv = [
      HEADER,
      "21201010,0,0,0,0,  ,0,  ,  ,  ,0.010,-3,  ,  ,  ,  ,  ,局,住所,問,一般局,4,21,市",
    ].join("\n");
    const out = parseSoramameNoudoAllCsv("210000", csv);
    expect(out.pm25).toBeNull();
    expect(out.raw.stationCount).toBe(0);
  });

  it("測定局コードの先頭 2 桁が都道府県コードと不一致の行（列ずれの兆候）は採らない（多層防御）", () => {
    const csv = [
      HEADER,
      // 都道府県コード列は '21' だが測定局コードは '99...'（列ずれ等の異常）→ skip。
      "99999010,0,0,0,0,  ,0,  ,  ,  ,0.010,40,  ,  ,  ,  ,  ,局,住所,問,一般局,4,21,市",
      // 正常な岐阜局。
      "21201010,0,0,0,0,  ,0,  ,  ,  ,0.010,12,  ,  ,  ,  ,  ,局,住所,問,一般局,4,21,市",
    ].join("\n");
    const out = parseSoramameNoudoAllCsv("210000", csv);
    // 異常行(40)は除外され、正常行(12)のみ集計される。
    expect(out.pm25).toBe(12);
    expect(out.raw.stationCount).toBe(1);
  });

  it("壊れた / 非文字列入力: throw せず全 null に倒す（last-known-good を壊さない）", () => {
    for (const broken of [null, undefined, 42, {}, [], true, ""]) {
      const out = parseSoramameNoudoAllCsv("210000", broken);
      expect(out.areaCode).toBe("210000");
      expect(out.areaName).toBeNull();
      expect(out.pm25).toBeNull();
      expect(out.pm25Band).toBeNull();
      expect(out.oxidant).toBeNull();
      expect(out.uvIndex).toBeNull();
      expect(out.uvBand).toBeNull();
      expect(out.raw.stationCount).toBe(0);
    }
  });

  it("SPA の HTML fallback（非 CSV）を渡されても該当府県行が無く全 null に倒れる（実 URL 不一致時の安全弁）", () => {
    const html =
      "<!DOCTYPE html><html lang=ja><head><title>そらまめくん</title></head><body></body></html>";
    const out = parseSoramameNoudoAllCsv("210000", html);
    expect(out.pm25).toBeNull();
    expect(out.raw.stationCount).toBe(0);
  });

  it("短すぎる / 不正な areaCode は安全に全 null", () => {
    expect(parseSoramameNoudoAllCsv("2", FULL_CSV).pm25).toBeNull();
    expect(parseSoramameNoudoAllCsv("", FULL_CSV).pm25).toBeNull();
  });
});
