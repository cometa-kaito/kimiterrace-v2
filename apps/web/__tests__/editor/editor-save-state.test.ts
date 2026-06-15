import { describe, expect, it } from "vitest";
import {
  AUTO_SAVE_STATUS_LABEL,
  EDITOR_SAVE_STATE_LABEL,
  deriveEditorSaveState,
  serializeForDirty,
} from "@/lib/editor/editor-save-state";

/**
 * #243 (②UI-UX): 教員エディタの保存状態 UX 純ロジックの単体検証。
 */

describe("serializeForDirty", () => {
  it("内容差で異なる文字列になる（dirty 検出）", () => {
    const a = serializeForDirty([{ period: 1, subject: "数学" }]);
    const b = serializeForDirty([{ period: 1, subject: "国語" }]);
    expect(a).not.toBe(b);
  });

  it("同一内容は同一文字列（保存後 dirty 解消）", () => {
    const a = serializeForDirty([{ text: "連絡", isHighlight: true }]);
    const b = serializeForDirty([{ text: "連絡", isHighlight: true }]);
    expect(a).toBe(b);
  });

  it("行の順序差を検出する", () => {
    const a = serializeForDirty([{ period: 1 }, { period: 2 }]);
    const b = serializeForDirty([{ period: 2 }, { period: 1 }]);
    expect(a).not.toBe(b);
  });
});

describe("deriveEditorSaveState", () => {
  it("変更ありは dirty（保存実績の有無に依らず）", () => {
    expect(deriveEditorSaveState({ dirty: true, savedOnce: false })).toBe("dirty");
    expect(deriveEditorSaveState({ dirty: true, savedOnce: true })).toBe("dirty");
  });

  it("変更なし & 保存実績ありは saved", () => {
    expect(deriveEditorSaveState({ dirty: false, savedOnce: true })).toBe("saved");
  });

  it("変更なし & 保存実績なしは idle", () => {
    expect(deriveEditorSaveState({ dirty: false, savedOnce: false })).toBe("idle");
  });
});

describe("EDITOR_SAVE_STATE_LABEL", () => {
  it("idle は空・dirty/saved は日本語ラベル", () => {
    expect(EDITOR_SAVE_STATE_LABEL.idle).toBe("");
    expect(EDITOR_SAVE_STATE_LABEL.dirty).toBe("未保存の変更があります");
    expect(EDITOR_SAVE_STATE_LABEL.saved).toBe("保存済み");
  });
});

describe("AUTO_SAVE_STATUS_LABEL", () => {
  it("idle は空・他は日本語ラベル（色だけに依存しない）", () => {
    expect(AUTO_SAVE_STATUS_LABEL.idle).toBe("");
    expect(AUTO_SAVE_STATUS_LABEL.saving).toBe("保存中…");
    expect(AUTO_SAVE_STATUS_LABEL.saved).toBe("自動保存しました");
    expect(AUTO_SAVE_STATUS_LABEL.error).toBe("保存に失敗しました");
    expect(AUTO_SAVE_STATUS_LABEL.incomplete).toContain("入力すると自動保存");
  });
});
