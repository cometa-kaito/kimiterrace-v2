import { describe, expect, it } from "vitest";
import {
  NOTICE_TONE_INSTRUCTIONS,
  buildNoticeAssistUser,
  jstDateLabel,
  parseNoticeProposal,
  parseNoticeTone,
} from "../../lib/editor/assistant-core";

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

describe("jstDateLabel", () => {
  it("epoch を JST の YYYY年M月D日（曜）に整形する", () => {
    // 2026-06-08T00:00:00Z = JST 2026-06-08 09:00（月）
    expect(jstDateLabel(Date.UTC(2026, 5, 8, 0, 0, 0))).toBe("2026年6月8日（月）");
  });

  it("UTC 夜は翌日の JST 日付になる（タイムゾーン反映）", () => {
    // 2026-06-07T20:00:00Z = JST 2026-06-08 05:00（月）
    expect(jstDateLabel(Date.UTC(2026, 5, 7, 20, 0, 0))).toBe("2026年6月8日（月）");
  });
});

describe("buildNoticeAssistUser", () => {
  it("基準日（今日）とメモを両方含める", () => {
    const u = buildNoticeAssistUser("明日は短縮授業", "2026年6月8日（月）");
    expect(u).toContain("基準日（今日）: 2026年6月8日（月）");
    expect(u).toContain("明日は短縮授業");
  });

  it("adjust 指示があれば【調整の指示】として付す（無ければ付さない）", () => {
    expect(buildNoticeAssistUser("メモ", "2026年6月8日（月）")).not.toContain("【調整の指示】");
    const u = buildNoticeAssistUser("メモ", "2026年6月8日（月）", "短くする。");
    expect(u).toContain("【調整の指示】短くする。");
  });
});

describe("parseNoticeTone / NOTICE_TONE_INSTRUCTIONS", () => {
  it("既知のトーンキーのみ受理し、未知/非文字列は null（外部入力を信用しない）", () => {
    expect(parseNoticeTone("short")).toBe("short");
    expect(parseNoticeTone("polite")).toBe("polite");
    expect(parseNoticeTone("evil")).toBeNull();
    expect(parseNoticeTone(42)).toBeNull();
    expect(parseNoticeTone(undefined)).toBeNull();
  });

  it("全トーンキーに固定指示文が定義されている", () => {
    for (const key of [
      "short",
      "detailed",
      "polite",
      "soft",
      "concise",
      "formal",
      "rephrase",
      "bullet",
      "plain",
    ] as const) {
      expect(NOTICE_TONE_INSTRUCTIONS[key].length).toBeGreaterThan(0);
    }
  });
});
