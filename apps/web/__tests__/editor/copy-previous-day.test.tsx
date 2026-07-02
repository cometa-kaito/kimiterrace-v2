import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * 前日コピー（F3）ボタンの UX を固定する。前営業日計算・保存・監査・RLS は Server Action（mock）。
 * - 既存入力があるときは**上書き確認**を挟み、キャンセルなら action を呼ばない。
 * - 確認 OK / 既存入力なしなら action を呼び、成功時に router.refresh で再初期化する。
 */

const h = vi.hoisted(() => ({
  copy: vi.fn(async (..._a: unknown[]) => ({
    ok: true as const,
    data: { fromDate: "2026-06-12", counts: { schedules: 3, notices: 1, assignments: 2 } },
  })),
  refresh: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: h.refresh, push: vi.fn() }),
}));
vi.mock("@/lib/editor/copy-day-actions", () => ({
  copyPreviousDayAction: (...a: unknown[]) => h.copy(...a),
}));

import { CopyPreviousDayButton } from "../../app/app/editor/[classId]/_components/CopyPreviousDayButton";

const CLASS_ID = "11111111-1111-1111-1111-111111111111";
const DATE = "2026-06-15";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("CopyPreviousDayButton（前日コピー）", () => {
  it("既存入力なしなら確認なしでコピーし、成功後に refresh する", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<CopyPreviousDayButton classId={CLASS_ID} date={DATE} hasExistingData={false} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "前日をコピー" }));
    });
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(h.copy).toHaveBeenCalledWith(CLASS_ID, DATE);
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/前営業日（2026-06-12）を複製しました/)).toBeInTheDocument();
  });

  it("既存入力ありで確認をキャンセルすると action を呼ばない", () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<CopyPreviousDayButton classId={CLASS_ID} date={DATE} hasExistingData={true} />);
    fireEvent.click(screen.getByRole("button", { name: "前日をコピー" }));
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(h.copy).not.toHaveBeenCalled();
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("既存入力ありで確認 OK ならコピーする", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<CopyPreviousDayButton classId={CLASS_ID} date={DATE} hasExistingData={true} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "前日をコピー" }));
    });
    expect(h.copy).toHaveBeenCalledWith(CLASS_ID, DATE);
  });

  it("失敗時はエラーメッセージを出し、refresh しない", async () => {
    h.copy.mockResolvedValueOnce({
      ok: false as const,
      error: {
        code: "invalid",
        message: "前営業日（2026-06-12）に複製できる予定・連絡・提出物がありません。",
      },
    } as never);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<CopyPreviousDayButton classId={CLASS_ID} date={DATE} hasExistingData={false} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "前日をコピー" }));
    });
    expect(screen.getByText(/複製できる予定・連絡・提出物がありません/)).toBeInTheDocument();
    expect(h.refresh).not.toHaveBeenCalled();
  });
});
