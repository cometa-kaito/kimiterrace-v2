import { describe, expect, it } from "vitest";
import { isClearedStatus, parseJmaWarning } from "../jma-warning.js";

/**
 * ADR-044: JMA 警報・注意報 JSON の純粋パースを fixture で検証する（ネットワーク非依存）。
 *
 * fixture は気象庁 bosai `warning/{areaCode}.json` の構造を縮約したもの。実 API のフォーマット変化に対する
 * 防御（欠損で落とさない・null/空化）と maxLevel 導出（特別警報 > 警報 > 注意報 > none、解除は除外）も検証する。
 * 実 PG / RLS の振る舞いは packages/db の weather-warnings.test.ts（実 PG）でカバーする。
 */

describe("isClearedStatus", () => {
  it("解除（'解除' / '0'）を解除扱いにする", () => {
    expect(isClearedStatus("解除")).toBe(true);
    expect(isClearedStatus(" 解除 ")).toBe(true);
    expect(isClearedStatus("0")).toBe(true);
  });
  it("発表 / 継続 / null は解除ではない", () => {
    expect(isClearedStatus("発表")).toBe(false);
    expect(isClearedStatus("継続")).toBe(false);
    expect(isClearedStatus(null)).toBe(false);
  });
});

describe("parseJmaWarning", () => {
  it("正常: 警報・注意報を正規化し maxLevel を導出する", () => {
    const json = {
      reportDatetime: "2026-06-18T10:39:00+09:00",
      headlineText: "岐阜県では、土砂災害に警戒してください。",
      areaTypes: [
        {
          areas: [
            {
              code: "210010",
              name: "美濃地方",
              warnings: [
                { code: "03", status: "発表" }, // 大雨警報
                { code: "14", status: "継続" }, // 雷注意報
              ],
            },
          ],
        },
      ],
    };
    const out = parseJmaWarning("210000", json);
    expect(out.areaCode).toBe("210000");
    expect(out.reportDatetime).toBe("2026-06-18T10:39:00+09:00");
    expect(out.headline).toBe("岐阜県では、土砂災害に警戒してください。");
    // 大雨警報(warning) > 雷注意報(advisory) → maxLevel = warning。
    expect(out.maxLevel).toBe("warning");
    expect(out.warnings).toEqual([
      { code: "03", name: "大雨警報", level: "warning", status: "発表", areaName: "美濃地方" },
      { code: "14", name: "雷注意報", level: "advisory", status: "継続", areaName: "美濃地方" },
    ]);
  });

  it("注意報のみ: maxLevel = advisory", () => {
    const json = {
      areaTypes: [{ areas: [{ name: "飛騨地方", warnings: [{ code: "15", status: "発表" }] }] }],
    };
    const out = parseJmaWarning("210000", json);
    expect(out.maxLevel).toBe("advisory");
    expect(out.warnings[0]).toMatchObject({ code: "15", name: "強風注意報", level: "advisory" });
  });

  it("特別警報: maxLevel = emergency（最上位を採る）", () => {
    const json = {
      areaTypes: [
        {
          areas: [
            {
              name: "美濃地方",
              warnings: [
                { code: "10", status: "発表" }, // 大雨注意報
                { code: "33", status: "発表" }, // 大雨特別警報
              ],
            },
          ],
        },
      ],
    };
    const out = parseJmaWarning("210000", json);
    expect(out.maxLevel).toBe("emergency");
  });

  it("解除のみ: 出ている警報が無いので maxLevel = none（解除は maxLevel から除外）", () => {
    const json = {
      areaTypes: [
        {
          areas: [
            {
              name: "美濃地方",
              warnings: [
                { code: "03", status: "解除" }, // 大雨警報 解除
                { code: "07", status: "0" }, // 波浪警報 数値解除
              ],
            },
          ],
        },
      ],
    };
    const out = parseJmaWarning("210000", json);
    expect(out.maxLevel).toBe("none");
    // 解除済も配列には残す（表示側が status を見て扱う）。
    expect(out.warnings).toHaveLength(2);
    expect(out.warnings.map((w) => w.status)).toEqual(["解除", "0"]);
  });

  it("未知コード: name/level は null になり maxLevel に影響しない（fail-soft）", () => {
    const json = {
      areaTypes: [
        {
          areas: [
            {
              name: "美濃地方",
              warnings: [
                { code: "99", status: "発表" }, // 未知コード
                { code: "10", status: "発表" }, // 大雨注意報
              ],
            },
          ],
        },
      ],
    };
    const out = parseJmaWarning("210000", json);
    expect(out.warnings[0]).toMatchObject({ code: "99", name: null, level: null });
    // 未知コードは段階導出に寄与しない → 注意報のみで advisory。
    expect(out.maxLevel).toBe("advisory");
  });

  it("壊れた / 空 JSON: throw せず空・none に倒す（fail-soft、last-known-good を壊さない）", () => {
    for (const broken of [null, undefined, 42, "x", [], {}, { areaTypes: "nope" }]) {
      const out = parseJmaWarning("210000", broken);
      expect(out.areaCode).toBe("210000");
      expect(out.maxLevel).toBe("none");
      expect(out.warnings).toEqual([]);
      expect(out.reportDatetime).toBeNull();
      expect(out.headline).toBeNull();
    }
  });

  it("複数 areaTypes / 複数細分区域を全て走査して maxLevel を集約する", () => {
    const json = {
      areaTypes: [
        { areas: [{ name: "美濃地方", warnings: [{ code: "14", status: "発表" }] }] }, // 雷注意報
        { areas: [{ name: "飛騨地方", warnings: [{ code: "05", status: "発表" }] }] }, // 暴風警報
      ],
    };
    const out = parseJmaWarning("210000", json);
    expect(out.warnings).toHaveLength(2);
    expect(out.maxLevel).toBe("warning"); // 暴風警報が最大
  });
});
