import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AdThumbnail } from "../../app/_components/AdThumbnail";

/**
 * AdThumbnail — 広告素材サムネイルの**安全境界**を固定する。`safeHttpOrRelative`（非 export）は
 * 危険スキーム（`javascript:`/`data:`）とプロトコル相対 `//host`（オープンリダイレクト）を弾く防御点なので、
 * 描画結果（原寸リンク `<a href>` の有無）で回帰を防ぐ。jest-dom 非依存（getAttribute / queryByRole）。
 */
describe("AdThumbnail", () => {
  it("同一オリジン /ad-media/… は原寸リンク化する（target=_blank + noopener）", () => {
    render(<AdThumbnail mediaUrl="/ad-media/ads/s/abc.png" mediaType="image" caption="広告A" />);
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("/ad-media/ads/s/abc.png");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel") ?? "").toContain("noopener");
  });

  it("http(s) 絶対 URL はリンク化する", () => {
    render(<AdThumbnail mediaUrl="https://cdn.example.com/a.png" mediaType="image" />);
    expect(screen.getByRole("link").getAttribute("href")).toBe("https://cdn.example.com/a.png");
  });

  it("javascript: スキームはリンク化しない（XSS 防止）", () => {
    // 単一リテラルに "javascript:" を作らない（lint 回避）。実値は javascript:alert(1)。
    render(<AdThumbnail mediaUrl={`${"javascript"}:alert(1)`} mediaType="image" />);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("data: スキームはリンク化しない", () => {
    render(<AdThumbnail mediaUrl="data:text/html,x" mediaType="image" />);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("プロトコル相対 //host はリンク化しない（オープンリダイレクト防止）", () => {
    render(<AdThumbnail mediaUrl="//evil.example.com/x" mediaType="image" />);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("mediaUrl 欠落はプレースホルダー（リンク無し）", () => {
    render(<AdThumbnail mediaUrl={null} mediaType="image" />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByLabelText("素材なし")).not.toBeNull();
  });

  it("linkToFull=false はリンク化しない", () => {
    render(<AdThumbnail mediaUrl="/ad-media/x.png" mediaType="image" linkToFull={false} />);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("video は <video>（先頭フレーム）を描画する", () => {
    const { container } = render(<AdThumbnail mediaUrl="/ad-media/s/v.mp4" mediaType="video" />);
    expect(container.querySelector("video")).not.toBeNull();
  });
});
