import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Issue #311: pdfjs-dist `standard_fonts/` 同梱漏れの早期検知。
 *
 * `resolveStandardFontDataUrl` はパス解決成功だけでは「フォントがある」と判定せず、実ファイルの存在まで
 * 確認する（Next standalone の file-tracing が動的 `file://` を追えず同梱漏れする本番固有の失敗を想定）。
 * `assertStandardFontsAvailable` は解決不能時に throw して本番起動を fail-fast させる。
 *
 * 正常系は実 node_modules のフォント実体に対して、異常系は `node:fs` をモックして
 * 「ディレクトリはあるがフォントファイルが無い／ディレクトリ自体が無い」状況を再現して検証する。
 */
describe("assertStandardFontsAvailable / standard_fonts 解決 (Issue #311)", () => {
  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.resetModules();
  });

  it("実 node_modules にフォント実体があれば throw しない", async () => {
    const { assertStandardFontsAvailable } = await import("../extractors.js");
    expect(() => assertStandardFontsAvailable()).not.toThrow();
  });

  it("standard_fonts にフォントファイルが無い（空 trace）と throw する", async () => {
    vi.resetModules();
    vi.doMock("node:fs", () => ({
      existsSync: () => true,
      // README 等はあるがフォント実体 (.pfb/.ttf/.otf/.bcmap) が無い → 同梱漏れ相当。
      readdirSync: () => ["LICENSE", "README.md"],
    }));
    const { assertStandardFontsAvailable } = await import("../extractors.js");
    expect(() => assertStandardFontsAvailable()).toThrow(/standard_fonts/);
  });

  it("standard_fonts ディレクトリ自体が無いと throw する（メッセージに Issue 番号）", async () => {
    vi.resetModules();
    vi.doMock("node:fs", () => ({
      existsSync: () => false,
      readdirSync: () => {
        throw new Error("ENOENT");
      },
    }));
    const { assertStandardFontsAvailable } = await import("../extractors.js");
    expect(() => assertStandardFontsAvailable()).toThrow(/Issue #311/);
  });

  it("フォント実体が 1 つでもあれば（.ttf）解決成功で throw しない", async () => {
    vi.resetModules();
    vi.doMock("node:fs", () => ({
      existsSync: () => true,
      readdirSync: () => ["LiberationSans-Regular.ttf"],
    }));
    const { assertStandardFontsAvailable } = await import("../extractors.js");
    expect(() => assertStandardFontsAvailable()).not.toThrow();
  });
});
