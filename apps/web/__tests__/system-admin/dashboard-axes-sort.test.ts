import { describe, expect, it } from "vitest";
import {
  type AdEventSummary,
  type AdvertiserEventSummary,
  sortAdSummaries,
  sortAdvertiserSummaries,
} from "../../lib/system-admin/dashboard-axes";

/**
 * 運営整理 §4 item2: 全校ダッシュボード「企業別 / 枠別」のメモリ内ソートの純テスト。
 * 集計 SQL（getEventStatsBy*Range）は実 PG 依存のためここでは検証せず、決定的な並べ替え規則のみ固定する。
 */

function adv(
  advertiserId: string,
  companyName: string,
  totals: { view: number; tap: number; ask: number },
  reactions: number,
): AdvertiserEventSummary {
  return { advertiserId, companyName, totals, reactions };
}

function ad(
  adId: string,
  caption: string | null,
  companyName: string | null,
  totals: { view: number; tap: number; ask: number },
  reactions: number,
): AdEventSummary {
  return { adId, caption, companyName, totals, reactions };
}

describe("sortAdvertiserSummaries", () => {
  const rows = [
    adv("a1", "あ社", { view: 1, tap: 1, ask: 0 }, 2),
    adv("a2", "い社", { view: 5, tap: 3, ask: 1 }, 8),
    adv("a3", "う社", { view: 3, tap: 0, ask: 9 }, 3),
  ];

  it("reactions 降順 (既定)", () => {
    const s = sortAdvertiserSummaries(rows, { sort: "reactions", dir: "desc" });
    expect(s.map((r) => r.advertiserId)).toEqual(["a2", "a3", "a1"]);
  });

  it("ask 昇順", () => {
    const s = sortAdvertiserSummaries(rows, { sort: "ask", dir: "asc" });
    expect(s.map((r) => r.advertiserId)).toEqual(["a1", "a2", "a3"]);
  });

  it("companyName でソート (文字列列)", () => {
    const s = sortAdvertiserSummaries(rows, { sort: "companyName", dir: "asc" });
    expect(s.map((r) => r.companyName)).toEqual(["あ社", "い社", "う社"]);
  });

  it("同値は会社名→id 昇順で決定的 (非破壊)", () => {
    const tie = [
      adv("b2", "同名", { view: 1, tap: 0, ask: 0 }, 1),
      adv("b1", "同名", { view: 1, tap: 0, ask: 0 }, 1),
    ];
    const s = sortAdvertiserSummaries(tie, { sort: "reactions", dir: "desc" });
    expect(s.map((r) => r.advertiserId)).toEqual(["b1", "b2"]);
    // 入力配列は変更しない。
    expect(tie.map((r) => r.advertiserId)).toEqual(["b2", "b1"]);
  });
});

describe("sortAdSummaries", () => {
  const rows = [
    ad("x1", "い広告", "い社", { view: 2, tap: 1, ask: 0 }, 3),
    ad("x2", null, null, { view: 9, tap: 1, ask: 0 }, 10),
    ad("x3", "あ広告", "あ社", { view: 1, tap: 0, ask: 0 }, 1),
  ];

  it("reactions 降順 (既定)", () => {
    const s = sortAdSummaries(rows, { sort: "reactions", dir: "desc" });
    expect(s.map((r) => r.adId)).toEqual(["x2", "x1", "x3"]);
  });

  it("caption 昇順は null を空文字として扱う", () => {
    const s = sortAdSummaries(rows, { sort: "caption", dir: "asc" });
    // null(=空文字) が先頭、その後 日本語ロケール順。
    expect(s.map((r) => r.adId)).toEqual(["x2", "x3", "x1"]);
  });

  it("companyName 昇順も null を空文字扱い", () => {
    const s = sortAdSummaries(rows, { sort: "companyName", dir: "asc" });
    expect(s[0]?.adId).toBe("x2"); // null company first
  });

  it("同値は id 昇順で決定的", () => {
    const tie = [
      ad("c2", "同", "社", { view: 1, tap: 0, ask: 0 }, 1),
      ad("c1", "同", "社", { view: 1, tap: 0, ask: 0 }, 1),
    ];
    const s = sortAdSummaries(tie, { sort: "view", dir: "desc" });
    expect(s.map((r) => r.adId)).toEqual(["c1", "c2"]);
  });
});
