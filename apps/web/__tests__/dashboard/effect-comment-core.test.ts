import type { EffectCommentStats } from "@kimiterrace/ai";
import { unmaskPII } from "@kimiterrace/ai";
import { describe, expect, it } from "vitest";
import { maskStats } from "../../lib/dashboard/effect-comment-core";

/**
 * F08 (#44, slice 2): `maskStats` (Vertex 送信前マスク集約) の単体検証。純粋関数なので DB / Vertex 不要。
 *
 * セキュリティ不変条件 (ルール4): topContent タイトルの書式 PII (電話/メール) が **マスク後テキストに
 * 残らない**こと、辞書で逆変換可能なこと、タイトル間のトークン番号衝突が起きないこと、月ラベル/件数/
 * metrics が素通り (PII 非対象) であることを突く。
 */

function stats(topContent: EffectCommentStats["topContent"]): EffectCommentStats {
  return {
    month: "2026-06",
    metrics: [{ label: "閲覧", current: 1, previous: 0 }],
    topContent,
  };
}

/** マスク後 topContent[i] のタイトル (存在を assert して narrow)。 */
function titleAt(s: EffectCommentStats, i: number): string {
  const entry = s.topContent[i];
  expect(entry).toBeDefined();
  return (entry as { title: string }).title;
}

describe("maskStats (Vertex 送信前マスク)", () => {
  it("電話番号を含むタイトルをトークン化し、辞書で復元できる・leak なし", () => {
    const { maskedStats, dictionary, leaks } = maskStats(
      stats([{ title: "連絡先 090-1234-5678 体育祭", reactions: 10 }]),
    );
    const masked = titleAt(maskedStats, 0);
    expect(masked).not.toContain("090-1234-5678");
    expect(masked).toMatch(/\{\{t0_PHONE_\d+\}\}/);
    expect(leaks).toEqual([]); // fail-closed: マスク漏れなし
    // 辞書で逆変換すると元に戻る (reactions は不変、masked のみ復元)。
    expect(unmaskPII(masked, dictionary)).toBe("連絡先 090-1234-5678 体育祭");
  });

  it("メールを含むタイトルもトークン化される", () => {
    const { maskedStats, leaks } = maskStats(
      stats([{ title: "申込 info@example.com まで", reactions: 3 }]),
    );
    const masked = titleAt(maskedStats, 0);
    expect(masked).not.toContain("info@example.com");
    expect(masked).toMatch(/\{\{t0_EMAIL_\d+\}\}/);
    expect(leaks).toEqual([]);
  });

  it("複数タイトルのトークンは衝突しない (タイトルごとに接頭辞)", () => {
    const { maskedStats, dictionary } = maskStats(
      stats([
        { title: "A 03-1111-2222", reactions: 9 },
        { title: "B 03-3333-4444", reactions: 8 },
      ]),
    );
    const t0 = titleAt(maskedStats, 0);
    const t1 = titleAt(maskedStats, 1);
    expect(t0).toMatch(/\{\{t0_PHONE_/);
    expect(t1).toMatch(/\{\{t1_PHONE_/);
    // 2 件分の辞書エントリが別キーで存在し、それぞれ別の番号へ復元する。
    expect(unmaskPII(t0, dictionary)).toBe("A 03-1111-2222");
    expect(unmaskPII(t1, dictionary)).toBe("B 03-3333-4444");
  });

  it("PII を含まないタイトルは素通り・月ラベル/metrics 不変", () => {
    const input = stats([{ title: "文化祭のお知らせ", reactions: 42 }]);
    const { maskedStats, dictionary, leaks } = maskStats(input);
    expect(titleAt(maskedStats, 0)).toBe("文化祭のお知らせ");
    expect(maskedStats.month).toBe("2026-06");
    expect(maskedStats.metrics).toEqual(input.metrics);
    expect(dictionary).toEqual({});
    expect(leaks).toEqual([]);
  });

  it("空 topContent: 空のまま、辞書/leak も空", () => {
    const { maskedStats, dictionary, leaks } = maskStats(stats([]));
    expect(maskedStats.topContent).toEqual([]);
    expect(dictionary).toEqual({});
    expect(leaks).toEqual([]);
  });
});
