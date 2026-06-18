import { describe, expect, it } from "vitest";
import { parseSoramameAir, pm25ToBand } from "../env-air.js";

/**
 * ADR-046: そらまめくん大気質の純粋パースを fixture で検証する（ネットワーク非依存）。
 *
 * そらまめくんは正規 API 契約が確認できない JS SPA（最も脆いソース）のため、入力は形が不確実な `unknown`。
 * 本テストは **防御（欠落/未知形式で落とさない・null 化）**、PM2.5 の複数候補キー解決、PM2.5 区分導出、UV 非取得
 * （常に null）を固定する。実 PG / RLS の振る舞いは packages/db の air-quality.test.ts（実 PG）でカバーする。
 */

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

describe("parseSoramameAir", () => {
  it("代表的な測定値オブジェクト: pm25=24 → moderate、areaName を拾い raw に原文保全", () => {
    const out = parseSoramameAir("210000", { pm25: 24, prefName: "岐阜県" });
    expect(out.areaCode).toBe("210000");
    expect(out.areaName).toBe("岐阜県");
    expect(out.pm25).toBe(24);
    expect(out.pm25Band).toBe("moderate");
    expect(out.oxidant).toBeNull();
    // UV は本 PR 未取得（常に null）。
    expect(out.uvIndex).toBeNull();
    expect(out.uvBand).toBeNull();
    // 原文（取得層が渡した生オブジェクト）を raw.source に保全。
    expect(out.raw.source).toEqual({ pm25: 24, prefName: "岐阜県" });
  });

  it("PM2.5 の候補キー違い（PM25 / pm2_5 / 'PM2.5'）・文字列値・少数を防御的に拾う", () => {
    expect(parseSoramameAir("x", { PM25: "8" }).pm25).toBe(8); // 文字列 → 数値
    expect(parseSoramameAir("x", { pm2_5: 40 }).pm25).toBe(40);
    expect(parseSoramameAir("x", { "PM2.5": "33.7" }).pm25).toBe(33); // 切り捨て
    expect(parseSoramameAir("x", { PM25: "8" }).pm25Band).toBe("good");
    expect(parseSoramameAir("x", { pm2_5: 40 }).pm25Band).toBe("unhealthy");
  });

  it("オキシダント（任意指標）も候補キーで拾えれば保持する", () => {
    const out = parseSoramameAir("210000", { pm25: 10, ox: 28 });
    expect(out.pm25).toBe(10);
    expect(out.oxidant).toBe(28);
  });

  it("PM2.5 が無い / 欠測コード（'-', '***', 空）: pm25 / band は null（fail-soft）", () => {
    expect(parseSoramameAir("x", { temp: 20 }).pm25).toBeNull();
    expect(parseSoramameAir("x", { pm25: "-" }).pm25).toBeNull();
    expect(parseSoramameAir("x", { pm25: "***" }).pm25).toBeNull();
    expect(parseSoramameAir("x", { pm25: "" }).pm25).toBeNull();
    expect(parseSoramameAir("x", { pm25: "-" }).pm25Band).toBeNull();
  });

  it("負値の PM2.5（異常値）は null に倒す（fail-soft）", () => {
    expect(parseSoramameAir("x", { pm25: -3 }).pm25).toBeNull();
  });

  it("壊れた / 非オブジェクト入力: throw せず全 null に倒す（last-known-good を壊さない）", () => {
    for (const broken of [null, undefined, 42, "garbage", [], true]) {
      const out = parseSoramameAir("210000", broken);
      expect(out.areaCode).toBe("210000");
      expect(out.areaName).toBeNull();
      expect(out.pm25).toBeNull();
      expect(out.pm25Band).toBeNull();
      expect(out.oxidant).toBeNull();
      expect(out.uvIndex).toBeNull();
      expect(out.uvBand).toBeNull();
    }
  });

  it("配列は非オブジェクト扱いで全 null（取得層が先頭要素を渡す責務。parser は単体オブジェクトのみ受ける）", () => {
    const out = parseSoramameAir("210000", [{ pm25: 24 }]);
    expect(out.pm25).toBeNull();
    // 原文は保全する（後追い解析用）。
    expect(out.raw.source).toEqual([{ pm25: 24 }]);
  });
});
