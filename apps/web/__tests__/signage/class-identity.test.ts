import { describe, expect, it } from "vitest";
import { formatClassIdentity } from "@/lib/signage/class-identity";

/**
 * #243 (②UI-UX): サイネージ識別ラベルの整形ロジックの単体検証。
 */

describe("formatClassIdentity", () => {
  it("学科・学年・クラスが揃えば 学科 学年 クラス を連結", () => {
    expect(
      formatClassIdentity({ departmentName: "電子工学科", gradeName: "1年", className: "A組" }),
    ).toBe("電子工学科 1年 A組");
  });

  it("学科が無ければ 学年 クラス（class モードの学校）", () => {
    expect(formatClassIdentity({ departmentName: null, gradeName: "1年", className: "1組" })).toBe(
      "1年 1組",
    );
  });

  it("クラスのみでも表示する", () => {
    expect(
      formatClassIdentity({ departmentName: null, gradeName: null, className: "電子1A" }),
    ).toBe("電子1A");
  });

  it("全て未設定 / null / undefined は空文字", () => {
    expect(formatClassIdentity({ departmentName: null, gradeName: null, className: null })).toBe(
      "",
    );
    expect(formatClassIdentity(null)).toBe("");
    expect(formatClassIdentity(undefined)).toBe("");
  });

  it("空白のみの値は無視する", () => {
    expect(formatClassIdentity({ departmentName: "  ", gradeName: "2年", className: "  " })).toBe(
      "2年",
    );
  });
});
