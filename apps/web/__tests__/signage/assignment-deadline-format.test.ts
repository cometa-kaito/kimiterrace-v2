import {
  DEFAULT_ASSIGNMENT_DEADLINE_FORMAT,
  isAssignmentDeadlineFormat,
  parseAssignmentDeadlineFormat,
} from "@/lib/signage/assignment-deadline-format";
import { describe, expect, it } from "vitest";

/**
 * 提出物の期日表示形式（#1258 学校別設定）の defensive パースのテスト。
 * `display_settings` は opaque JSONB（他キー相乗り・旧データ・手編集がありうる）ため、
 * 形不正・未知値はすべて既定 `daysLeft` に倒れること（fail-soft・盤面を壊さない）を担保する。
 */

describe("isAssignmentDeadlineFormat", () => {
  it("既知の 2 値のみ true", () => {
    expect(isAssignmentDeadlineFormat("daysLeft")).toBe(true);
    expect(isAssignmentDeadlineFormat("until")).toBe(true);
    expect(isAssignmentDeadlineFormat("bogus")).toBe(false);
    expect(isAssignmentDeadlineFormat(1)).toBe(false);
    expect(isAssignmentDeadlineFormat(null)).toBe(false);
    expect(isAssignmentDeadlineFormat(undefined)).toBe(false);
  });
});

describe("parseAssignmentDeadlineFormat", () => {
  it("display_settings.assignmentDeadlineFormat が既知なら採用、それ以外は既定", () => {
    expect(parseAssignmentDeadlineFormat({ assignmentDeadlineFormat: "until" })).toBe("until");
    expect(parseAssignmentDeadlineFormat({ assignmentDeadlineFormat: "daysLeft" })).toBe(
      "daysLeft",
    );
    expect(parseAssignmentDeadlineFormat({ assignmentDeadlineFormat: "bogus" })).toBe("daysLeft");
  });

  it("他キー（signageDesign 等）が相乗りしていても本キーだけを読む", () => {
    expect(
      parseAssignmentDeadlineFormat({
        signageDesign: "pattern2",
        editorDayCutover: "16:00",
        assignmentDeadlineFormat: "until",
      }),
    ).toBe("until");
    // 本キー欠落（signageDesign のみの既存行）は既定。
    expect(parseAssignmentDeadlineFormat({ signageDesign: "pattern2" })).toBe("daysLeft");
  });

  it("行なし・形不正はすべて既定に倒す（fail-soft）", () => {
    expect(parseAssignmentDeadlineFormat(null)).toBe(DEFAULT_ASSIGNMENT_DEADLINE_FORMAT);
    expect(parseAssignmentDeadlineFormat(undefined)).toBe(DEFAULT_ASSIGNMENT_DEADLINE_FORMAT);
    expect(parseAssignmentDeadlineFormat("until")).toBe(DEFAULT_ASSIGNMENT_DEADLINE_FORMAT);
    expect(parseAssignmentDeadlineFormat(["until"])).toBe(DEFAULT_ASSIGNMENT_DEADLINE_FORMAT);
    expect(parseAssignmentDeadlineFormat(42)).toBe(DEFAULT_ASSIGNMENT_DEADLINE_FORMAT);
    expect(parseAssignmentDeadlineFormat({ assignmentDeadlineFormat: { nested: "until" } })).toBe(
      DEFAULT_ASSIGNMENT_DEADLINE_FORMAT,
    );
  });
});
