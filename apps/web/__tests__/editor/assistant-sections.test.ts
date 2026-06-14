import { describe, expect, it } from "vitest";
import {
  resolveAllowedSections,
  resolveManualSectionLabels,
} from "../../lib/editor/assistant-sections";

/**
 * パターン準拠セクション解決（assistant-sections）の検証。其他レーンの単一ソース `PATTERN_BLOCKS`
 * （`editableBlocksForPattern`）を consume し、会話型 AI が下書きできるセクション（schedule/notice/
 * assignment）と、AI が作らない手入力セクション（来校者/呼び出し・ADR-034）を導く（finding①）。
 * 本テストは実 PATTERN_BLOCKS を使う（独自表を作らない＝ドリフトしたら本テストが落ちて気づける）。
 */

describe("resolveAllowedSections", () => {
  it("pattern1 = 予定/連絡/提出物（3 種とも AI 下書き可）", () => {
    expect(resolveAllowedSections("pattern1")).toEqual(["schedules", "notices", "assignments"]);
  });

  it("pattern2 = 予定のみ（来校者/呼び出しは AI 生成しない・ADR-034）", () => {
    expect(resolveAllowedSections("pattern2")).toEqual(["schedules"]);
  });
});

describe("resolveManualSectionLabels", () => {
  it("pattern1 は手入力セクション無し（編集ブロックは全て AI 下書き可）", () => {
    expect(resolveManualSectionLabels("pattern1")).toEqual([]);
  });

  it("pattern2 は来校者/呼び出しを手入力ラベルとして返す（AI 誘導用）", () => {
    expect(resolveManualSectionLabels("pattern2")).toEqual(["生徒呼び出し", "来校者一覧"]);
  });
});
