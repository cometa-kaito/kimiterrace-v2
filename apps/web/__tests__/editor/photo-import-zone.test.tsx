import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * P1 写真取込のゾーン1 導線（PhotoImportZone）を固定する。**UI/受け渡しのみ**（OCR/ガードは
 * photo-import-actions.test.ts が担当・action はモック）。
 * - ファイル選択（input change）→ action 呼び出し → 成功で context に注入ターンが積まれる
 * - 失敗 reason → 教員向け文言の表示（pending は積まれない）
 * - スマホのカメラ直起動（capture="environment"）と MIME 絞り（png/jpeg・iOS の HEIC 自動変換前提）
 */

const h = vi.hoisted(() => ({ action: vi.fn() }));
vi.mock("../../lib/editor/photo-import-actions", () => ({
  photoImportChatMessageAction: h.action,
}));

import { PhotoImportZone } from "../../app/app/editor/[classId]/_components/PhotoImportZone";
import {
  PhotoImportProvider,
  usePhotoImport,
} from "../../app/app/editor/[classId]/_components/photo-import-context";

/** context の pending を可視化する観測用プローブ（FloatingAiChat / EditorChat の代役）。 */
function PendingProbe() {
  const ctx = usePhotoImport();
  return <output data-testid="pending">{ctx?.pendingMessage ?? ""}</output>;
}

function renderZone() {
  return render(
    <PhotoImportProvider>
      <PhotoImportZone classId="c1" />
      <PendingProbe />
    </PhotoImportProvider>,
  );
}

function selectPng(container: HTMLElement) {
  const input = container.querySelector('input[type="file"]');
  if (!(input instanceof HTMLInputElement)) throw new Error("file input not found");
  const file = new File([new ArrayBuffer(8)], "print.png", { type: "image/png" });
  fireEvent.change(input, { target: { files: [file] } });
  return input;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("PhotoImportZone", () => {
  it("input はスマホでカメラ直起動（capture=environment）＋ png/jpeg 限定（D6）", () => {
    const { container } = renderZone();
    const input = container.querySelector('input[type="file"]');
    expect(input).not.toBeNull();
    expect(input?.getAttribute("capture")).toBe("environment");
    expect(input?.getAttribute("accept")).toBe("image/png,image/jpeg");
  });

  it("ファイル選択 → action 成功で context に注入ターンが積まれる", async () => {
    h.action.mockResolvedValue({ ok: true, message: "【プリント本文】\n7月7日の時間割変更" });
    const { container } = renderZone();
    selectPng(container);
    await waitFor(() => {
      expect(screen.getByTestId("pending").textContent).toContain("7月7日の時間割変更");
    });
    expect(h.action).toHaveBeenCalledTimes(1);
    const [scope, targetId, fd] = h.action.mock.calls[0] ?? [];
    expect(scope).toBe("class");
    expect(targetId).toBe("c1");
    expect(fd).toBeInstanceOf(FormData);
    expect((fd as FormData).get("file")).toBeInstanceOf(File);
  });

  it("失敗 reason は教員向け文言で表示し、pending は積まない", async () => {
    h.action.mockResolvedValue({ ok: false, reason: "no_text" });
    const { container } = renderZone();
    selectPng(container);
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("文字を読み取れませんでした");
    });
    expect(screen.getByTestId("pending").textContent).toBe("");
  });

  it("action が throw しても汎用文言に畳む（未処理 rejection にしない）", async () => {
    h.action.mockRejectedValue(new Error("network"));
    const { container } = renderZone();
    selectPng(container);
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("取り込みに失敗しました");
    });
  });
});
