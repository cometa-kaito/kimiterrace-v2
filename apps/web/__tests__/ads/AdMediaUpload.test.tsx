import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdMediaUpload } from "../../app/admin/editor/[classId]/ads/_components/AdMediaUpload";

/**
 * #46 / ADR-037: AdMediaUpload — ファイル選択 → multipart POST /api/ads/media → 成功時 onUploaded で
 * 配信 URL を親へ返す挙動と、クライアント早期検証 / サーバーエラー写像を検証する。fetch を mock する。
 */

function mockFetch(impl: () => Promise<Response>) {
  const fn = vi.fn(impl);
  vi.stubGlobal("fetch", fn);
  return fn;
}

function selectFile(bytes: number, type: string, name = "ad.png") {
  const file = new File([new Uint8Array(Math.min(bytes, 8))], name, { type });
  Object.defineProperty(file, "size", { value: bytes });
  const input = screen.getByLabelText(/画像をアップロード/);
  fireEvent.change(input, { target: { files: [file] } });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("AdMediaUpload", () => {
  it("PNG を選び 201 → onUploaded(url, mediaType) を呼び成功表示", async () => {
    const fetchFn = mockFetch(() =>
      Promise.resolve({
        ok: true,
        status: 201,
        json: async () => ({ url: "/ad-media/ads/s/abc.png", mediaType: "image" }),
      } as Response),
    );
    const onUploaded = vi.fn();
    render(<AdMediaUpload onUploaded={onUploaded} />);
    selectFile(1024, "image/png");
    fireEvent.click(screen.getByRole("button", { name: "アップロード" }));

    await waitFor(() =>
      expect(onUploaded).toHaveBeenCalledWith("/ad-media/ads/s/abc.png", "image"),
    );
    expect(fetchFn).toHaveBeenCalledWith(
      "/api/ads/media",
      expect.objectContaining({ method: "POST" }),
    );
    await waitFor(() => screen.getByText(/アップロードしました/));
  });

  it("サーバーが 415 → エラー文言を出し onUploaded は呼ばない", async () => {
    mockFetch(() => Promise.resolve({ ok: false, status: 415 } as Response));
    const onUploaded = vi.fn();
    render(<AdMediaUpload onUploaded={onUploaded} />);
    selectFile(1024, "image/png");
    fireEvent.click(screen.getByRole("button", { name: "アップロード" }));

    await waitFor(() => screen.getByText(/対応していない形式/));
    expect(onUploaded).not.toHaveBeenCalled();
  });

  it("201 だが不正な body（url が /ad-media/ で始まらない）は onUploaded を呼ばずエラー表示", async () => {
    mockFetch(() =>
      Promise.resolve({
        ok: true,
        status: 201,
        json: async () => ({ url: "https://evil.example/x.png", mediaType: "image" }),
      } as Response),
    );
    const onUploaded = vi.fn();
    render(<AdMediaUpload onUploaded={onUploaded} />);
    selectFile(1024, "image/png");
    fireEvent.click(screen.getByRole("button", { name: "アップロード" }));

    await waitFor(() => screen.getByText(/解釈できませんでした/));
    expect(onUploaded).not.toHaveBeenCalled();
  });

  it("クライアント検証: 許可外 MIME は fetch せずエラー表示", () => {
    const fetchFn = mockFetch(() => Promise.resolve({ ok: true, status: 201 } as Response));
    render(<AdMediaUpload onUploaded={vi.fn()} />);
    selectFile(1024, "image/gif", "x.gif");
    fireEvent.click(screen.getByRole("button", { name: "アップロード" }));

    expect(screen.getByText(/対応していない形式/)).toBeTruthy();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("クライアント検証: 50MB 超は fetch せずエラー表示", () => {
    const fetchFn = mockFetch(() => Promise.resolve({ ok: true, status: 201 } as Response));
    render(<AdMediaUpload onUploaded={vi.fn()} />);
    selectFile(60 * 1024 * 1024, "image/png");
    fireEvent.click(screen.getByRole("button", { name: "アップロード" }));

    expect(screen.getByText(/大きすぎ/)).toBeTruthy();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("ファイル未選択でアップロード押下はエラー表示", () => {
    render(<AdMediaUpload onUploaded={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "アップロード" }));
    expect(screen.getByText(/ファイルを選択/)).toBeTruthy();
  });
});
