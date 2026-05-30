import { describe, expect, it } from "vitest";
import {
  REVIEW_CONFIDENCE_THRESHOLD,
  SCOPE_OPTIONS,
  needsReview,
  scopeLabel,
  statusLabel,
  statusTone,
} from "../../lib/contents/publish-view";

describe("SCOPE_OPTIONS (F04.4 公開先明示)", () => {
  it("4 スコープすべてを含む", () => {
    expect(SCOPE_OPTIONS.map((o) => o.value).sort()).toEqual([
      "class",
      "homeroom",
      "private",
      "school",
    ]);
  });

  it("全校 (school) を既定/先頭にしない (狭い範囲を優先、F04.4)", () => {
    expect(SCOPE_OPTIONS[0]?.value).not.toBe("school");
    expect(SCOPE_OPTIONS[0]?.value).toBe("class");
    // school は末尾側
    expect(SCOPE_OPTIONS.at(-1)?.value).toBe("school");
  });

  it("各選択肢に「誰に見えるか」の説明がある", () => {
    for (const opt of SCOPE_OPTIONS) {
      expect(opt.description.length).toBeGreaterThan(0);
    }
  });
});

describe("scopeLabel / statusLabel / statusTone", () => {
  it("scopeLabel", () => {
    expect(scopeLabel("school")).toBe("全校");
    expect(scopeLabel("class")).toBe("クラス");
  });
  it("statusLabel", () => {
    expect(statusLabel("draft")).toBe("下書き");
    expect(statusLabel("published")).toBe("公開中");
    expect(statusLabel("archived")).toBe("非公開");
  });
  it("statusTone", () => {
    expect(statusTone("published")).toBe("success");
    expect(statusTone("archived")).toBe("muted");
    expect(statusTone("draft")).toBe("neutral");
  });
});

describe("needsReview (F04.3 確信度フラグ)", () => {
  it("閾値 0.7 未満は要確認", () => {
    expect(needsReview(0.69)).toBe(true);
    expect(needsReview(0)).toBe(true);
  });
  it("閾値以上は要確認でない (境界含む)", () => {
    expect(needsReview(0.7)).toBe(false);
    expect(needsReview(0.71)).toBe(false);
    expect(needsReview(1)).toBe(false);
  });
  it("score 未取得 (null/undefined) はフラグを出さない", () => {
    expect(needsReview(null)).toBe(false);
    expect(needsReview(undefined)).toBe(false);
  });
  it("閾値はカスタム可能", () => {
    expect(needsReview(0.8, 0.9)).toBe(true);
    expect(REVIEW_CONFIDENCE_THRESHOLD).toBe(0.7);
  });
});
