import { describe, expect, it } from "vitest";
import { safeHttpOrRelative } from "../../app/_components/AdThumbnail";

/**
 * `AdThumbnail` の `<a href>` サニタイザ `safeHttpOrRelative` をピン留めする。
 * 同一オリジン相対パス（単一 `/` 始まり）と http(s) 絶対 URL だけを採用し、別オリジンへ飛ぶ
 * オープンリダイレクト（プロトコル相対 `//host`・`/\host`）と危険スキームを弾くことを保証する。
 * 由来: PR #1040 CodeQL トリアージの side note（docs/security/codeql-triage-2026-06-18.md）。
 */
describe("safeHttpOrRelative", () => {
  it("同一オリジン相対パス（単一 `/` 始まり）を verbatim で採用する", () => {
    expect(safeHttpOrRelative("/ad-media/x.png")).toBe("/ad-media/x.png");
    expect(safeHttpOrRelative("/ad-media/ads/abc/def.png")).toBe("/ad-media/ads/abc/def.png");
    expect(safeHttpOrRelative("/")).toBe("/");
  });

  it("http(s) 絶対 URL を採用する", () => {
    expect(safeHttpOrRelative("https://cdn.example.com/a.png")).toBe(
      "https://cdn.example.com/a.png",
    );
    expect(safeHttpOrRelative("http://example.com/a.mp4")).toBe("http://example.com/a.mp4");
  });

  it("`/\\host`（先頭スラッシュ直後がバックスラッシュ）をオープンリダイレクトとして弾く", () => {
    // 一部ブラウザが `\`→`/` 正規化で `//evil.com`（protocol-relative）に解釈する経路。
    expect(safeHttpOrRelative("/\\evil.com")).toBeNull();
    expect(safeHttpOrRelative("/\\/evil.com")).toBeNull();
    expect(safeHttpOrRelative("/\\\\evil.com")).toBeNull();
  });

  it("プロトコル相対 `//host` を弾く", () => {
    expect(safeHttpOrRelative("//evil.com")).toBeNull();
    expect(safeHttpOrRelative("//evil.com/path")).toBeNull();
  });

  it("危険スキーム（javascript:/data:）を弾く", () => {
    expect(safeHttpOrRelative("javascript:alert(1)")).toBeNull();
    expect(safeHttpOrRelative("data:text/html,<script>alert(1)</script>")).toBeNull();
  });

  it("バックスラッシュ始まり等の不正値を弾く", () => {
    expect(safeHttpOrRelative("\\\\evil.com")).toBeNull();
    expect(safeHttpOrRelative("\\/evil.com")).toBeNull();
    expect(safeHttpOrRelative("")).toBeNull();
    expect(safeHttpOrRelative("not a url")).toBeNull();
  });
});
