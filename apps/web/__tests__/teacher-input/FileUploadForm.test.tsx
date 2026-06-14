import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F01 (#509 S3b) FileUploadForm: ファイル選択 → multipart POST → 成功表示 / クライアント早期検証 /
 * サーバーエラー写像を検証する。fetch と CreateDraftButton 経由の action を mock する。
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/teacher-input/draft-actions", () => ({
  createDraftFromInputAction: vi.fn(),
}));

import { FileUploadForm } from "../../app/app/teacher-input/_components/FileUploadForm";

function mockFetch(impl: () => Promise<Response>) {
  const fn = vi.fn(impl);
  vi.stubGlobal("fetch", fn);
  return fn;
}

function selectFile(bytes: number, type: string, name = "x.pdf") {
  const file = new File([new Uint8Array(Math.min(bytes, 8))], name, { type });
  // file.size は 8 までしか実体が無いので、テストでは size を上書きして上限検証する。
  Object.defineProperty(file, "size", { value: bytes });
  const input = screen.getByLabelText(/ファイルから取り込む/);
  fireEvent.change(input, { target: { files: [file] } });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("FileUploadForm", () => {
  it("PDF を選択し 201 でアップロード成功 → 編集して公開ボタンを出す", async () => {
    const fetchFn = mockFetch(() =>
      Promise.resolve({
        ok: true,
        status: 201,
        json: async () => ({ input: { id: "ti-9" }, extraction: { status: "extracted" } }),
      } as Response),
    );
    render(<FileUploadForm />);
    selectFile(1024, "application/pdf");
    fireEvent.click(screen.getByRole("button", { name: "アップロード" }));

    await waitFor(() => screen.getByText(/アップロードしました/));
    expect(fetchFn).toHaveBeenCalledWith(
      "/api/teacher-inputs/upload",
      expect.objectContaining({ method: "POST" }),
    );
    // 文書ファイルは下書き作成ボタンが出る
    expect(screen.getByRole("button", { name: "編集して公開" })).toBeTruthy();
  });

  it("画像 (pending_ocr) は下書きボタンを出さず、準備中の旨を表示", async () => {
    mockFetch(() =>
      Promise.resolve({
        ok: true,
        status: 201,
        json: async () => ({ input: { id: "ti-img" }, extraction: { status: "pending_ocr" } }),
      } as Response),
    );
    render(<FileUploadForm />);
    selectFile(1024, "image/png", "p.png");
    fireEvent.click(screen.getByRole("button", { name: "アップロード" }));

    await waitFor(() => screen.getByText(/文字起こしは準備中/));
    expect(screen.queryByRole("button", { name: "編集して公開" })).toBeNull();
  });

  it("許可外 MIME はクライアントで弾き fetch しない", async () => {
    const fetchFn = mockFetch(() => Promise.reject(new Error("should not fetch")));
    render(<FileUploadForm />);
    selectFile(1024, "application/x-msdownload", "evil.exe");
    fireEvent.click(screen.getByRole("button", { name: "アップロード" }));
    await waitFor(() => screen.getByRole("alert"));
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("50MB 超はクライアントで弾き fetch しない", async () => {
    const fetchFn = mockFetch(() => Promise.reject(new Error("should not fetch")));
    render(<FileUploadForm />);
    selectFile(50 * 1024 * 1024 + 1, "application/pdf");
    fireEvent.click(screen.getByRole("button", { name: "アップロード" }));
    await waitFor(() => screen.getByRole("alert"));
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("サーバーが 415 を返すと対応形式エラーを表示", async () => {
    mockFetch(() =>
      Promise.resolve({ ok: false, status: 415, json: async () => ({}) } as Response),
    );
    render(<FileUploadForm />);
    selectFile(1024, "application/pdf");
    fireEvent.click(screen.getByRole("button", { name: "アップロード" }));
    await waitFor(() => screen.getByText(/対応していない形式/));
  });
});
