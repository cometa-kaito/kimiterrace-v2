import { describe, expect, it } from "vitest";
import { pickPattern3NewsRows } from "../../lib/signage/news";

/**
 * pattern3 廊下フッタの「要約あり優先＋不足時のみ見出し補完」選別（{@link pickPattern3NewsRows}）の検証。
 *
 * 背景: フッタは要約（本文）あり記事を 1 件ずつ自動送りする設計（2026-06-22 指定）だが、要約は CC BY ソース
 * （実質 経産省 METI）のみ非 null のため、METI の発表が数日空く（週末/閑散期）と廊下フッタが固定される
 * （本番で 6/19 固定を観測・2026-06-23）。対策として、要約あり記事が鮮度窓(48h)内なら従来どおり要約のみ、
 * 古い/無い時だけ JST・文科省の見出しも混ぜ公開日降順（最新優先）で返す。`now` を固定して決定論的に検証する。
 */

// テスト最小行（pickPattern3NewsRows のジェネリック制約 = { summary, publishedAt } を満たす）。
type Row = { id: string; summary: string | null; publishedAt: Date | null };

const NOW = new Date("2026-06-23T00:00:00Z");
const hoursAgo = (h: number): Date => new Date(NOW.getTime() - h * 60 * 60 * 1000);

describe("pickPattern3NewsRows（要約あり優先＋不足時のみ見出し補完）", () => {
  it("要約あり記事が鮮度窓(48h)内なら、より新しい見出しのみ記事を混ぜず要約あり記事だけを返す", () => {
    const rows: Row[] = [
      { id: "meti-fresh", summary: "経産省の公式要約。", publishedAt: hoursAgo(10) },
      // 見出しのみ（要約 null）はこちらが新しくても除外される（通常運用 = 本文ありのみ）。
      { id: "jst-newer", summary: null, publishedAt: hoursAgo(2) },
      { id: "mext-newer", summary: null, publishedAt: hoursAgo(1) },
    ];
    expect(pickPattern3NewsRows(rows, NOW).map((r) => r.id)).toEqual(["meti-fresh"]);
  });

  it("要約あり記事が複数で新鮮なら、その順序を保ったまま要約あり記事のみ返す", () => {
    const rows: Row[] = [
      { id: "meti-a", summary: "要約A。", publishedAt: hoursAgo(5) },
      { id: "meti-b", summary: "要約B。", publishedAt: hoursAgo(30) },
      { id: "jst", summary: null, publishedAt: hoursAgo(1) },
    ];
    // getLatestNews の要約あり優先ソート順（入力順）を保持し、見出しのみ jst は出さない。
    expect(pickPattern3NewsRows(rows, NOW).map((r) => r.id)).toEqual(["meti-a", "meti-b"]);
  });

  it("要約あり記事が鮮度窓より古い時は、見出しのみ記事も混ぜ公開日降順（最新優先）で返す", () => {
    const rows: Row[] = [
      // getLatestNews は要約あり優先ソートなので要約ありが先頭で来る想定。pick が公開日降順へ並べ直す。
      { id: "meti-stale", summary: "経産省の古い要約。", publishedAt: hoursAgo(96) }, // 4日前(窓外)
      { id: "jst-new", summary: null, publishedAt: hoursAgo(20) },
      { id: "mext-new", summary: null, publishedAt: hoursAgo(8) },
    ];
    // 最新の見出し記事が先頭、古い要約記事は後段（鮮度回復）。
    expect(pickPattern3NewsRows(rows, NOW).map((r) => r.id)).toEqual([
      "mext-new",
      "jst-new",
      "meti-stale",
    ]);
  });

  it("要約あり記事が無い時は、見出しのみ記事を公開日降順で返す", () => {
    const rows: Row[] = [
      { id: "jst", summary: null, publishedAt: hoursAgo(30) },
      { id: "mext", summary: null, publishedAt: hoursAgo(5) },
    ];
    expect(pickPattern3NewsRows(rows, NOW).map((r) => r.id)).toEqual(["mext", "jst"]);
  });

  it("空白のみの summary は要約なし扱い（補完運用に倒れる）", () => {
    const rows: Row[] = [
      { id: "blank", summary: "   ", publishedAt: hoursAgo(1) },
      { id: "jst", summary: null, publishedAt: hoursAgo(40) },
    ];
    // 要約あり実質 0 件 → 補完。公開日降順。
    expect(pickPattern3NewsRows(rows, NOW).map((r) => r.id)).toEqual(["blank", "jst"]);
  });

  it("要約あり記事の publishedAt が null なら鮮度に数えず補完運用に倒れる", () => {
    const rows: Row[] = [
      { id: "meti-nodate", summary: "日付不明の要約。", publishedAt: null },
      { id: "jst-new", summary: null, publishedAt: hoursAgo(3) },
    ];
    // summary はあるが publishedAt null → 鮮度 0 → 補完。公開日ありが先、null は末尾。
    expect(pickPattern3NewsRows(rows, NOW).map((r) => r.id)).toEqual(["jst-new", "meti-nodate"]);
  });

  it("limit を超える分は切り詰める（既定 5 / 引数指定）", () => {
    const rows: Row[] = Array.from({ length: 8 }, (_, i) => ({
      id: `n${i}`,
      summary: null,
      publishedAt: hoursAgo(i + 1),
    }));
    expect(pickPattern3NewsRows(rows, NOW).length).toBe(5); // 既定 SIGNAGE_NEWS_LIMIT
    expect(pickPattern3NewsRows(rows, NOW, 3).length).toBe(3);
  });

  it("空配列は空配列（fail-soft）", () => {
    expect(pickPattern3NewsRows([], NOW)).toEqual([]);
  });
});
