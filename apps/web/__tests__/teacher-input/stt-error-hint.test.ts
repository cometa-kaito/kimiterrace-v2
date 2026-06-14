import { describe, expect, it } from "vitest";
import { sttErrorHint } from "../../lib/teacher-input/stt-error-hint";

/**
 * STT エラーコード → 教員向けヒントの写像（純関数）の固定。
 *
 * マイク実機は CI で再現できないため、「どのコードでヒントを出す / 出さない」をここで pin する
 * （PR #876 Reviewer 指摘・非ブロッキング対応）。良性コードでヒントを出さないこと（誤警告回避）が肝。
 */
describe("sttErrorHint", () => {
  it("未発生（null / 空文字）はヒントを出さない", () => {
    expect(sttErrorHint(null)).toBeNull();
    expect(sttErrorHint("")).toBeNull();
  });

  it("良性コード（no-speech / aborted）はヒントを出さない（誤警告回避）", () => {
    expect(sttErrorHint("no-speech")).toBeNull();
    expect(sttErrorHint("aborted")).toBeNull();
  });

  it("権限拒否（not-allowed / service-not-allowed）は権限を促すヒントを出す", () => {
    for (const code of ["not-allowed", "service-not-allowed"]) {
      const hint = sttErrorHint(code);
      expect(hint).not.toBeNull();
      expect(hint).toContain("許可");
    }
  });

  it("マイク取得失敗（audio-capture）はマイクに言及するヒントを出す", () => {
    const hint = sttErrorHint("audio-capture");
    expect(hint).not.toBeNull();
    expect(hint).toContain("マイク");
  });

  it("非対応（unsupported）は対応していない旨のヒントを出す", () => {
    const hint = sttErrorHint("unsupported");
    expect(hint).not.toBeNull();
    expect(hint).toContain("対応していません");
  });

  it("その他の失敗（network / 未知コード）は汎用ヒントを出す", () => {
    expect(sttErrorHint("network")).not.toBeNull();
    expect(sttErrorHint("some-unexpected-code")).not.toBeNull();
  });
});
