import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 来校者一覧 / 生徒呼び出しエディタの **保存モデル統一（finding #16）** と **時刻ピッカー（finding #10）** を固定する。
 *
 * - #16: 旧実装は手動「保存」ボタンだったが、予定/連絡/提出物と同じ自動保存（{@link useAutoSaveSection}）に
 *   統一した。本テストは「手動保存ボタンが無い」「氏名が揃うと debounce 後に自動保存する」「未入力では保存
 *   しない」を固定し、手動保存への逆戻り・自動保存配線の退行を検知する。
 * - #10: 時刻入力が `type="time"`（ネイティブピッカー）であることを固定する。
 *
 * 保存・検証・RLS/監査は Server Action 側が担うため action をモックし、UI と自動保存の配線のみ見る。
 */

const h = vi.hoisted(() => ({
  setVisitorsAction: vi.fn(async (..._a: unknown[]) => ({ ok: true, data: { count: 1 } })),
  setCalloutsAction: vi.fn(async (..._a: unknown[]) => ({ ok: true, data: { count: 1 } })),
}));
vi.mock("@/lib/editor/visitors-actions", () => ({
  setVisitorsAction: (...a: unknown[]) => h.setVisitorsAction(...a),
}));
vi.mock("@/lib/editor/callouts-actions", () => ({
  setCalloutsAction: (...a: unknown[]) => h.setCalloutsAction(...a),
}));

import { CalloutsEditor } from "../../app/app/editor/[classId]/_components/CalloutsEditor";
import { VisitorsEditor } from "../../app/app/editor/[classId]/_components/VisitorsEditor";

const CLASS_ID = "11111111-1111-1111-1111-111111111111";
const DATE = "2026-06-22";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("来校者/呼び出し — 自動保存統一（#16）・時刻ピッカー（#10）", () => {
  it("手動「保存」ボタンを廃止し、追加ボタンのみ残す（自動保存に統一）", () => {
    render(<VisitorsEditor classId={CLASS_ID} date={DATE} initialItems={[]} />);
    expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
    expect(screen.queryByRole("button", { name: "保存中..." })).toBeNull();
    expect(screen.getByRole("button", { name: "来校者を追加" })).toBeTruthy();
  });

  it("呼び出しも手動「保存」ボタンを廃止している", () => {
    render(<CalloutsEditor classId={CLASS_ID} date={DATE} initialItems={[]} />);
    expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
    expect(screen.getByRole("button", { name: "呼び出しを追加" })).toBeTruthy();
  });

  it('時刻入力は type="time" のネイティブピッカー（#10）', () => {
    render(
      <VisitorsEditor
        classId={CLASS_ID}
        date={DATE}
        initialItems={[
          {
            scheduledTime: "10:00",
            visitorName: "山田太郎",
            affiliation: null,
            purpose: null,
            host: null,
            note: null,
          } as never,
        ]}
      />,
    );
    expect(screen.getByLabelText("1 行目の時刻").getAttribute("type")).toBe("time");
  });

  it("来校者: 氏名が未入力の間は保存せず、揃うと debounce 後に自動保存する", async () => {
    render(<VisitorsEditor classId={CLASS_ID} date={DATE} initialItems={[]} />);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "来校者を追加" }));
    });
    // 氏名未入力（不完全）の間は debounce を過ぎても保存しない。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200);
    });
    expect(h.setVisitorsAction).not.toHaveBeenCalled();

    // 氏名を入力 → 全行有効 → debounce 後に自動保存。
    act(() => {
      fireEvent.change(screen.getByLabelText("1 行目の氏名"), { target: { value: "山田太郎" } });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(h.setVisitorsAction).toHaveBeenCalledTimes(1);
    expect(h.setVisitorsAction).toHaveBeenCalledWith(CLASS_ID, DATE, [
      expect.objectContaining({ visitorName: "山田太郎" }),
    ]);
  });

  it("呼び出し: 氏名が揃うと debounce 後に自動保存する", async () => {
    render(<CalloutsEditor classId={CLASS_ID} date={DATE} initialItems={[]} />);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "呼び出しを追加" }));
    });
    act(() => {
      fireEvent.change(screen.getByLabelText("1 行目の生徒氏名"), {
        target: { value: "佐藤花子" },
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(h.setCalloutsAction).toHaveBeenCalledTimes(1);
    expect(h.setCalloutsAction).toHaveBeenCalledWith(CLASS_ID, DATE, [
      expect.objectContaining({ studentName: "佐藤花子" }),
    ]);
  });
});
