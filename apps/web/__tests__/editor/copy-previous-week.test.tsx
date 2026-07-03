import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * 前週コピー（C2）ボタンの UX を固定する。週割り・保存・監査・RLS は Server Action（mock）。
 * - 今週の既存入力を上書きする一括操作なので**必ず確認**を挟み、キャンセルなら action を呼ばない。
 * - 成功時は `?copied=<nonce>` を付けた `router.replace` で再ナビゲートする（page.tsx がエディタ key に
 *   含めて再マウント＝複製後データで初期化。`router.refresh` では useState(initial…) が残り画面に反映されない・
 *   前日コピーの Reviewer 指摘 HIGH と同じ回帰ガード）。
 */

type CopyWeekResult =
  | { ok: true; data: { fromWeekStart: string; toWeekStart: string; daysCopied: number } }
  | { ok: false; error: { code: string; message: string } };

const h = vi.hoisted(() => ({
  copy: vi.fn(
    async (
      ..._a: unknown[]
    ): Promise<
      | { ok: true; data: { fromWeekStart: string; toWeekStart: string; daysCopied: number } }
      | { ok: false; error: { code: string; message: string } }
    > => ({
      ok: true,
      data: { fromWeekStart: "2026-06-01", toWeekStart: "2026-06-08", daysCopied: 4 },
    }),
  ),
  replace: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: h.replace, refresh: h.refresh, push: vi.fn() }),
  usePathname: () => "/app/editor/11111111-1111-1111-1111-111111111111",
  useSearchParams: () => new URLSearchParams("date=2026-06-10"),
}));
vi.mock("@/lib/editor/copy-day-actions", () => ({
  copyPreviousWeekAction: (...a: unknown[]) => h.copy(...a),
}));

import { CopyPreviousWeekButton } from "../../app/app/editor/[classId]/_components/CopyPreviousWeekButton";

const CLASS_ID = "11111111-1111-1111-1111-111111111111";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("CopyPreviousWeekButton（前週コピー）", () => {
  it("確認 OK でコピーし、成功後に ?copied=<nonce> 付きで replace（再マウント）・結果メッセージを出す", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<CopyPreviousWeekButton classId={CLASS_ID} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "今週へ前週をコピー" }));
    });
    // 今週を上書きする一括操作なので確認は常に必須。
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(h.copy).toHaveBeenCalledWith(CLASS_ID);
    // refresh ではなく copied nonce 付きの replace（同一日付でもエディタ key が変わり再マウントされる）。
    expect(h.refresh).not.toHaveBeenCalled();
    expect(h.replace).toHaveBeenCalledTimes(1);
    const [url, opts] = h.replace.mock.calls[0] as [string, { scroll?: boolean }];
    expect(url).toMatch(/^\/app\/editor\/11111111-1111-1111-1111-111111111111\?/);
    expect(url).toContain("date=2026-06-10");
    expect(url).toMatch(/copied=\d+/);
    expect(opts).toEqual({ scroll: false });
    expect(
      screen.getByText(/前週（2026-06-01 の週）を今週へ複製しました（4 日分）/),
    ).toBeInTheDocument();
  });

  it("確認をキャンセルすると action を呼ばない（誤上書き防止）", () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<CopyPreviousWeekButton classId={CLASS_ID} />);
    fireEvent.click(screen.getByRole("button", { name: "今週へ前週をコピー" }));
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(h.copy).not.toHaveBeenCalled();
    expect(h.replace).not.toHaveBeenCalled();
  });

  it("失敗時はエラーメッセージを出し、再ナビゲートしない", async () => {
    const failure: CopyWeekResult = {
      ok: false,
      error: {
        code: "invalid",
        message: "前週（2026-06-01 の週）に複製できる予定・連絡・提出物がありません。",
      },
    };
    h.copy.mockResolvedValueOnce(failure);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<CopyPreviousWeekButton classId={CLASS_ID} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "今週へ前週をコピー" }));
    });
    expect(screen.getByText(/複製できる予定・連絡・提出物がありません/)).toBeInTheDocument();
    expect(h.replace).not.toHaveBeenCalled();
  });
});
