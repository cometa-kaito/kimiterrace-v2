import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * {@link SeedConfirmButton}（基本時間割 seed のワンクリック確定・忠実度 2026-07-06）を固定する。
 *
 * - 押下で seed 内容がそのまま setScheduleAction（既存の保存経路）へ渡ること
 * - 成功で `?applied=<nonce>` 再ナビ（#1245 と同じ確立済み手法・date 固定・scroll:false）が走ること
 * - 失敗時はナビゲーションせずエラーメッセージを出すこと（半端な確定を「完了」に見せない）
 */

const replaceMock = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock }),
  usePathname: () => "/app/editor/c1",
  useSearchParams: () => new URLSearchParams("date=2026-07-09"),
}));
vi.mock("../../lib/editor/schedule-actions", () => ({
  setScheduleAction: vi.fn(async () => ({ ok: true, data: { id: "d1" } })),
}));

import { SeedConfirmButton } from "../../app/app/editor/[classId]/_components/SeedConfirmButton";
import { setScheduleAction } from "../../lib/editor/schedule-actions";

const ITEMS = [
  { period: 1, subject: "国語" },
  { period: 2, subject: "数学" },
];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SeedConfirmButton（基本時間割 seed のワンクリック確定）", () => {
  it("押下で seed 内容を setScheduleAction へそのまま保存し、成功で ?applied= 再ナビ（date 固定・scroll:false）", async () => {
    render(<SeedConfirmButton classId="c1" date="2026-07-09" items={ITEMS} />);

    fireEvent.click(screen.getByRole("button", { name: "この内容で確定" }));

    await waitFor(() => expect(replaceMock).toHaveBeenCalledTimes(1));
    expect(setScheduleAction).toHaveBeenCalledWith("class", "c1", "2026-07-09", ITEMS);
    const [url, opts] = replaceMock.mock.calls[0] as [string, { scroll: boolean }];
    const params = new URLSearchParams(url.split("?")[1]);
    expect(url.startsWith("/app/editor/c1?")).toBe(true);
    expect(params.get("date")).toBe("2026-07-09");
    expect(params.get("applied")).toMatch(/^\d+$/);
    expect(opts).toEqual({ scroll: false });
  });

  it("保存失敗時はナビゲーションせずエラーメッセージを出す", async () => {
    vi.mocked(setScheduleAction).mockResolvedValueOnce({
      ok: false,
      error: { message: "保存に失敗しました" },
    } as never);
    render(<SeedConfirmButton classId="c1" date="2026-07-09" items={ITEMS} />);

    fireEvent.click(screen.getByRole("button", { name: "この内容で確定" }));

    await screen.findByText("保存に失敗しました");
    expect(replaceMock).not.toHaveBeenCalled();
  });
});
