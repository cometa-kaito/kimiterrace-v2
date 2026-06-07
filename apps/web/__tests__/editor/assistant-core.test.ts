import { describe, expect, it } from "vitest";
import { parseNoticeProposal } from "../../lib/editor/assistant-core";

/**
 * 段C: assistant-core の純パース検証（DB/Vertex 非依存）。モデルの生 JSON テキスト → NoticeItem[] の
 * 取り出し（コードフェンス除去・形検証・不正は null）を固める。
 */
describe("parseNoticeProposal", () => {
  it("正常な JSON から notices を取り出す", () => {
    const r = parseNoticeProposal(
      '{"notices":[{"text":"明日は短縮授業","isHighlight":true},{"text":"返却は金曜まで"}]}',
    );
    expect(r).toEqual([{ text: "明日は短縮授業", isHighlight: true }, { text: "返却は金曜まで" }]);
  });

  it("```json コードフェンス付きでも取り出す", () => {
    const r = parseNoticeProposal('```json\n{"notices":[{"text":"連絡A"}]}\n```');
    expect(r).toEqual([{ text: "連絡A" }]);
  });

  it("JSON でない/壊れた応答は null", () => {
    expect(parseNoticeProposal("これは連絡です")).toBeNull();
    expect(parseNoticeProposal('{"notices":')).toBeNull();
  });

  it("notices が空配列なら空配列（呼び出し側が no_result 判定）", () => {
    expect(parseNoticeProposal('{"notices":[]}')).toEqual([]);
  });

  it("有効な text を持つ要素が皆無なら null（呼び出し側が no_result 判定）", () => {
    expect(parseNoticeProposal('{"notices":[{"foo":"x"}]}')).toBeNull();
  });
});
