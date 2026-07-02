import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * 前日コピー（F3）ボタンの UX を固定する。前営業日計算・保存・監査・RLS は Server Action（mock）。
 * - 既存入力があるときは**上書き確認**を挟み、キャンセルなら action を呼ばない。
 * - 確認 OK / 既存入力なしなら action を呼び、成功時は `?copied=<nonce>` を付けた `router.replace` で
 *   再ナビゲートする（page.tsx がエディタ key に含めて再マウント＝複製後データで初期化。`router.refresh`
 *   では useState(initial…) が残り画面に反映されない・Reviewer 指摘 HIGH の回帰ガード）。
 */

type CopyResult =
  | {
      ok: true;
      data: {
        fromDate: string;
        counts: { schedules: number; notices: number; assignments: number };
      };
    }
  | { ok: false; error: { code: string; message: string } };

const h = vi.hoisted(() => ({
  copy: vi.fn(
    async (
      ..._a: unknown[]
    ): Promise<
      | {
          ok: true;
          data: {
            fromDate: string;
            counts: { schedules: number; notices: number; assignments: number };
          };
        }
      | { ok: false; error: { code: string; message: string } }
    > => ({
      ok: true,
      data: { fromDate: "2026-06-12", counts: { schedules: 3, notices: 1, assignments: 2 } },
    }),
  ),
  replace: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: h.replace, refresh: h.refresh, push: vi.fn() }),
  usePathname: () => "/app/editor/11111111-1111-1111-1111-111111111111",
  useSearchParams: () => new URLSearchParams("date=2026-06-15"),
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
  it("既存入力なしなら確認なしでコピーし、成功後に ?copied=<nonce> 付きで replace（再マウント）する", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<CopyPreviousDayButton classId={CLASS_ID} date={DATE} hasExistingData={false} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "前日をコピー" }));
    });
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(h.copy).toHaveBeenCalledWith(CLASS_ID, DATE);
    // refresh ではなく copied nonce 付きの replace（同一日付でもエディタ key が変わり再マウントされる）。
    expect(h.refresh).not.toHaveBeenCalled();
    expect(h.replace).toHaveBeenCalledTimes(1);
    const [url, opts] = h.replace.mock.calls[0] as [string, { scroll?: boolean }];
    expect(url).toMatch(/^\/app\/editor\/11111111-1111-1111-1111-111111111111\?/);
    expect(url).toContain("date=2026-06-15");
    expect(url).toMatch(/copied=\d+/);
    expect(opts).toEqual({ scroll: false });
    expect(screen.getByText(/前営業日（2026-06-12）を複製しました/)).toBeInTheDocument();
  });

  it("既存入力ありで確認をキャンセルすると action を呼ばない", () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<CopyPreviousDayButton classId={CLASS_ID} date={DATE} hasExistingData={true} />);
    fireEvent.click(screen.getByRole("button", { name: "前日をコピー" }));
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(h.copy).not.toHaveBeenCalled();
    expect(h.replace).not.toHaveBeenCalled();
  });

  it("既存入力ありで確認 OK ならコピーする", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<CopyPreviousDayButton classId={CLASS_ID} date={DATE} hasExistingData={true} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "前日をコピー" }));
    });
    expect(h.copy).toHaveBeenCalledWith(CLASS_ID, DATE);
  });

  it("失敗時はエラーメッセージを出し、再ナビゲートしない", async () => {
    const failure: CopyResult = {
      ok: false,
      error: {
        code: "invalid",
        message: "前営業日（2026-06-12）に複製できる予定・連絡・提出物がありません。",
      },
    };
    h.copy.mockResolvedValueOnce(failure);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<CopyPreviousDayButton classId={CLASS_ID} date={DATE} hasExistingData={false} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "前日をコピー" }));
    });
    expect(screen.getByText(/複製できる予定・連絡・提出物がありません/)).toBeInTheDocument();
    expect(h.replace).not.toHaveBeenCalled();
  });
});
