import { describe, expect, it } from "vitest";
import { validateFeedbackInput } from "../../lib/feedback/feedback-core";

/**
 * F12 (#48-M): フィードバック入力検証の unit テスト (純関数、副作用なし)。
 *
 * guide は非認証なのでここが第一防衛線。範囲・必須・正規化を網羅する (DB の CHECK + 関数
 * RAISE は二重防御として packages/db の RLS テストで担保)。
 */
describe("validateFeedbackInput", () => {
  it("必須スコアが揃い 1-5 範囲なら ok、テキストは trim + 空は null 化", () => {
    const r = validateFeedbackInput({
      schoolName: "  岐南工業高校  ",
      classroomLabel: "1-A",
      studentReaction: "5",
      teacherUtility: 4,
      studentEpisode: "   ",
      improvement: "文字を大きく",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.schoolName).toBe("岐南工業高校");
      expect(r.value.studentReaction).toBe(5);
      expect(r.value.teacherUtility).toBe(4);
      expect(r.value.studentEpisode).toBeNull(); // 空白のみ → null
      expect(r.value.improvement).toBe("文字を大きく");
      // guide からは schoolId を受け付けない (任意参照、null 固定)。
      expect(r.value.schoolId).toBeNull();
    }
  });

  it("studentReaction が範囲外 (0 / 6 / 非数) は invalid", () => {
    for (const bad of [0, 6, "x", undefined, null, ""]) {
      const r = validateFeedbackInput({ studentReaction: bad, teacherUtility: 3 });
      expect(r.ok, `studentReaction=${String(bad)}`).toBe(false);
    }
  });

  it("teacherUtility が範囲外は invalid", () => {
    for (const bad of [0, 6, "nope", undefined]) {
      const r = validateFeedbackInput({ studentReaction: 3, teacherUtility: bad });
      expect(r.ok, `teacherUtility=${String(bad)}`).toBe(false);
    }
  });

  it("小数は丸めて 1-5 に収まれば ok (4.6 → 5)", () => {
    const r = validateFeedbackInput({ studentReaction: 4.6, teacherUtility: 1.2 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.studentReaction).toBe(5);
      expect(r.value.teacherUtility).toBe(1);
    }
  });

  it("自由記述が長すぎる場合は invalid (DoS / 肥大化防止)", () => {
    const r = validateFeedbackInput({
      studentReaction: 3,
      teacherUtility: 3,
      studentEpisode: "あ".repeat(4001),
    });
    expect(r.ok).toBe(false);
  });

  it("任意項目を全省略しても必須スコアがあれば ok (省略は null)", () => {
    const r = validateFeedbackInput({ studentReaction: 1, teacherUtility: 5 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.schoolName).toBeNull();
      expect(r.value.classroomLabel).toBeNull();
      expect(r.value.studentEpisode).toBeNull();
      expect(r.value.improvement).toBeNull();
    }
  });
});
