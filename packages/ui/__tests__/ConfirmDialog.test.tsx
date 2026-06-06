import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "../src/ConfirmDialog";

function noop() {}

describe("ConfirmDialog", () => {
  it("open=false なら何も描画しない", () => {
    render(<ConfirmDialog open={false} title="公開しますか？" onConfirm={noop} onCancel={noop} />);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("open=true で alertdialog として title/description を描画する", () => {
    render(
      <ConfirmDialog
        open
        title="公開しますか？"
        description="全生徒の画面に表示されます。"
        onConfirm={noop}
        onCancel={noop}
      />,
    );
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByText("公開しますか？")).toBeInTheDocument();
    expect(screen.getByText("全生徒の画面に表示されます。")).toBeInTheDocument();
  });

  it("開いたら確認ボタンでなくダイアログ本体へフォーカスする（Enter 誤確認防止）", () => {
    render(<ConfirmDialog open title="確認" onConfirm={noop} onCancel={noop} />);
    expect(document.activeElement).toBe(screen.getByRole("alertdialog"));
  });

  it("確認ボタンで onConfirm、取消ボタンで onCancel を呼ぶ", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        open
        title="確認"
        confirmLabel="公開する"
        cancelLabel="やめる"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "公開する" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "やめる" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("Esc で onCancel、ただし pending 中は無効", () => {
    const onCancel = vi.fn();
    const { rerender } = render(
      <ConfirmDialog open title="確認" onConfirm={noop} onCancel={onCancel} />,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);

    rerender(<ConfirmDialog open pending title="確認" onConfirm={noop} onCancel={onCancel} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1); // 増えない（pending 中は Esc 無効）
  });

  it("背景クリックで onCancel、ダイアログ本体クリックでは取消しない", () => {
    const onCancel = vi.fn();
    render(<ConfirmDialog open title="確認" onConfirm={noop} onCancel={onCancel} />);
    const dialog = screen.getByRole("alertdialog");
    // 本体（内側）クリックはバブリングしても target≠currentTarget で無視。
    fireEvent.click(dialog);
    expect(onCancel).not.toHaveBeenCalled();
    // 背景（presentation = 親）クリックは取消。
    const backdrop = dialog.parentElement as HTMLElement;
    expect(backdrop).toHaveAttribute("role", "presentation");
    fireEvent.click(backdrop);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("pending 中は両ボタンを無効化し確認側を『処理中…』にする", () => {
    render(
      <ConfirmDialog
        open
        pending
        title="確認"
        confirmLabel="公開する"
        cancelLabel="やめる"
        onConfirm={noop}
        onCancel={noop}
      />,
    );
    expect(screen.getByRole("button", { name: "処理中…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "やめる" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "公開する" })).toBeNull();
  });

  it("tone=danger で確認ボタンを danger 配色にする", () => {
    render(
      <ConfirmDialog
        open
        tone="danger"
        title="削除しますか？"
        confirmLabel="削除する"
        onConfirm={noop}
        onCancel={noop}
      />,
    );
    expect(screen.getByRole("button", { name: "削除する" }).style.background).toBe(
      "rgb(185, 28, 28)", // dangerFg #b91c1c
    );
  });
});
