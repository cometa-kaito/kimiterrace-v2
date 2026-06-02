import { describe, expect, it } from "vitest";
import { DRAFT_TITLE_MAX_LENGTH, deriveDraftTitle } from "../../lib/teacher-input/draft-core";

/** F01/F02 (#509 S3b) 下書き title 導出の単体テスト。 */
describe("deriveDraftTitle", () => {
  it("最初の非空行を title にする", () => {
    expect(deriveDraftTitle("体育祭のお知らせ\n詳細は本文参照")).toBe("体育祭のお知らせ");
  });

  it("先頭の空行・空白をスキップして最初の実質行を採る", () => {
    expect(deriveDraftTitle("\n   \n  進路説明会  \n本文")).toBe("進路説明会");
  });

  it("空 / 空白のみ / 非文字列は既定値「無題の下書き」", () => {
    expect(deriveDraftTitle("")).toBe("無題の下書き");
    expect(deriveDraftTitle("   \n  \n")).toBe("無題の下書き");
    expect(deriveDraftTitle(null)).toBe("無題の下書き");
    expect(deriveDraftTitle(undefined)).toBe("無題の下書き");
  });

  it("上限超過は DRAFT_TITLE_MAX_LENGTH で丸める", () => {
    const long = "あ".repeat(DRAFT_TITLE_MAX_LENGTH + 50);
    expect(deriveDraftTitle(long).length).toBe(DRAFT_TITLE_MAX_LENGTH);
  });
});
