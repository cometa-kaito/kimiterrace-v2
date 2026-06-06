import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { type ToastTone, ToastProvider, useToast } from "../src/Toast";

/** useToast を click で呼ぶテスト用トリガ。 */
function Trigger({ tone, durationMs }: { tone?: ToastTone; durationMs?: number }) {
  const toast = useToast();
  return (
    <button type="button" onClick={() => toast("通知メッセージ", { tone, durationMs })}>
      出す
    </button>
  );
}

function renderWithTrigger(props: { tone?: ToastTone; durationMs?: number } = {}) {
  return render(
    <ToastProvider>
      <Trigger {...props} />
    </ToastProvider>,
  );
}

describe("Toast", () => {
  it("provider 外で useToast を呼ぶと throw（配線漏れ早期検知）", () => {
    expect(() => renderHook(() => useToast())).toThrow(/ToastProvider/);
  });

  it("toast() でメッセージを表示する", () => {
    renderWithTrigger({ tone: "success" });
    expect(screen.queryByText("通知メッセージ")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "出す" }));
    expect(screen.getByText("通知メッセージ")).toBeInTheDocument();
  });

  it("success/info は status、error は alert のライブリージョンにする", () => {
    const ok = renderWithTrigger({ tone: "success" });
    fireEvent.click(screen.getByRole("button", { name: "出す" }));
    expect(screen.getByRole("status")).toBeInTheDocument();
    ok.unmount();

    renderWithTrigger({ tone: "error" });
    fireEvent.click(screen.getByRole("button", { name: "出す" }));
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("『閉じる』で手動消滅する", () => {
    renderWithTrigger({ tone: "info" });
    fireEvent.click(screen.getByRole("button", { name: "出す" }));
    expect(screen.getByText("通知メッセージ")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
    expect(screen.queryByText("通知メッセージ")).toBeNull();
  });

  it("durationMs 経過で自動消滅する", () => {
    vi.useFakeTimers();
    try {
      renderWithTrigger({ tone: "info", durationMs: 3000 });
      fireEvent.click(screen.getByRole("button", { name: "出す" }));
      expect(screen.getByText("通知メッセージ")).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(2999);
      });
      expect(screen.getByText("通知メッセージ")).toBeInTheDocument(); // まだ残る
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(screen.queryByText("通知メッセージ")).toBeNull(); // 消える
    } finally {
      vi.useRealTimers();
    }
  });

  it("durationMs<=0 は自動消滅しない（手動で閉じる用途）", () => {
    vi.useFakeTimers();
    try {
      renderWithTrigger({ tone: "error", durationMs: 0 });
      fireEvent.click(screen.getByRole("button", { name: "出す" }));
      act(() => {
        vi.advanceTimersByTime(60000);
      });
      expect(screen.getByText("通知メッセージ")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("複数のトーストを積み重ねる", () => {
    renderWithTrigger({ tone: "info" });
    const btn = screen.getByRole("button", { name: "出す" });
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(screen.getAllByText("通知メッセージ")).toHaveLength(2);
  });
});
