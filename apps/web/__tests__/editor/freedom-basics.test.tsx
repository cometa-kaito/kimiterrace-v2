import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PR-B 自由度基本セット（設計書 editor-restructure-bulletin-2026-07.md §5.1〜5.3）のエディタ挙動を固定する。
 *
 * - **⠿ D&D の横展開（予定・提出物・§5.1）**: 「同一ソートキー内の並べ替え」方式。validate の強制ソートは
 *   安定なので、同一バケット（同じ特殊スロット / 同じ期限）内は配列順＝保存順＝盤面順。ドロップ後は
 *   クライアント側でもサーバと同じキーで安定再ソートし、**別バケットへ跨いだドロップはスナップバック**する
 *   （時限順 / 期限順の意味論を壊さない）。
 * - **区切り線（予定・連絡・§5.3）**: 「＋区切り線」で行タイプ `kind:"divider"` の行を追加し、既存の
 *   自動保存経路でそのまま保存される（ラベル任意・空なら純粋な罫線）。
 * - **★重要（§5.2）**: 「詳細」パネルの重要チェックが `isHighlight: true` として保存される。
 *
 * ポインタ D&D は jsdom 非対応のため、同じ並べ替え経路（moveRow）をグリップの ↑↓ キーで叩く
 * （notice-reorder.test.tsx と同作法）。Server Action は import 時に DB/認可を引き込むため mock。
 */

const h = vi.hoisted(() => ({
  push: vi.fn(),
  setScheduleAction: vi.fn(async (..._a: unknown[]) => ({ ok: true as const, data: { count: 0 } })),
  setNoticesAction: vi.fn(async (..._a: unknown[]) => ({ ok: true as const, data: { count: 0 } })),
  setAssignmentsAction: vi.fn(async (..._a: unknown[]) => ({
    ok: true as const,
    data: { count: 0 },
  })),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: h.push, refresh: vi.fn() }),
}));
vi.mock("@/lib/editor/schedule-actions", () => ({
  setScheduleAction: (...a: unknown[]) => h.setScheduleAction(...a),
}));
vi.mock("@/lib/editor/notice-assignment-actions", () => ({
  setNoticesAction: (...a: unknown[]) => h.setNoticesAction(...a),
  setAssignmentsAction: (...a: unknown[]) => h.setAssignmentsAction(...a),
}));

import { AssignmentEditor } from "../../app/app/editor/[classId]/_components/AssignmentEditor";
import { NoticeEditor } from "../../app/app/editor/[classId]/_components/NoticeEditor";
import { ScheduleEditor } from "../../app/app/editor/[classId]/_components/ScheduleEditor";
import { resortFilledRows } from "../../app/app/editor/[classId]/_components/useRowReorder";
import type { AssignmentItem } from "../../lib/editor/notice-assignment-core";
import type { ScheduleItem } from "../../lib/editor/schedule-core";

const CLASS_ID = "11111111-1111-1111-1111-111111111111";
const DATE = "2026-07-06";

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

/** debounce された自動保存を確実に発火させる。 */
async function flushAutoSave() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
}

function lastSaved<T>(mock: { mock: { calls: unknown[][] } }): T[] {
  const call = mock.mock.calls.at(-1) as unknown[];
  return call[3] as T[];
}

describe("ScheduleEditor ⠿並べ替え（§5.1 同一ソートキー内）", () => {
  const sameBucket: ScheduleItem[] = [
    { period: "afterschool", subject: "部活" },
    { period: "afterschool", subject: "三者面談" },
  ];

  it("同一バケット（放課後×2）内の ↑ 移動が保存順に反映される", async () => {
    render(<ScheduleEditor classId={CLASS_ID} date={DATE} initialItems={sameBucket} />);
    act(() => {
      fireEvent.keyDown(screen.getByRole("button", { name: "2 行目を並べ替え" }), {
        key: "ArrowUp",
      });
    });
    await flushAutoSave();
    expect(h.setScheduleAction).toHaveBeenCalled();
    const saved = lastSaved<ScheduleItem>(h.setScheduleAction);
    expect(saved.map((s) => s.subject)).toEqual(["三者面談", "部活"]);
  });

  it("別バケット（1限↔2限）へ跨いだ移動はスナップバック（時限順の意味論を壊さない＝保存も走らない）", async () => {
    render(
      <ScheduleEditor
        classId={CLASS_ID}
        date={DATE}
        initialItems={[
          { period: 1, subject: "数学" },
          { period: 2, subject: "国語" },
        ]}
      />,
    );
    act(() => {
      fireEvent.keyDown(screen.getByRole("button", { name: "2 行目を並べ替え" }), {
        key: "ArrowUp",
      });
    });
    // ドロップ後の安定再ソートで元の時限順へ戻る＝serialized 不変＝自動保存は発火しない。
    await flushAutoSave();
    expect(h.setScheduleAction).not.toHaveBeenCalled();
    const subjects = screen
      .getAllByLabelText(/行目の科目名/)
      .map((el) => (el as HTMLInputElement).value);
    expect(subjects).toEqual(["数学", "国語"]);
  });
});

describe("ScheduleEditor 区切り線（§5.3）", () => {
  it("「＋区切り線」で divider 行が追加され kind:'divider' で保存される（配列位置を保持）", async () => {
    render(
      <ScheduleEditor
        classId={CLASS_ID}
        date={DATE}
        initialItems={[{ period: 1, subject: "数学" }]}
      />,
    );
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "＋区切り線" }));
    });
    // ラベルを入れる（任意）。
    fireEvent.change(screen.getByLabelText("2 行目の区切り線ラベル"), {
      target: { value: "午後の部" },
    });
    await flushAutoSave();
    const saved = lastSaved<ScheduleItem>(h.setScheduleAction);
    expect(saved).toEqual([
      { period: 1, subject: "数学" },
      { kind: "divider", subject: "午後の部" },
    ]);
  });
});

describe("ScheduleEditor ★重要（§5.2）", () => {
  it("詳細パネルの重要チェックが isHighlight:true で保存される", async () => {
    render(
      <ScheduleEditor
        classId={CLASS_ID}
        date={DATE}
        initialItems={[{ period: 1, subject: "数学" }]}
      />,
    );
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "1 行目の詳細項目" }));
    });
    act(() => {
      fireEvent.click(screen.getByLabelText("1 行目の重要マーク"));
    });
    await flushAutoSave();
    const saved = lastSaved<ScheduleItem>(h.setScheduleAction);
    expect(saved).toEqual([{ period: 1, subject: "数学", isHighlight: true }]);
  });

  it("isHighlight 付きの初期値は詳細が最初から開く（設定済みを隠さない）", () => {
    render(
      <ScheduleEditor
        classId={CLASS_ID}
        date={DATE}
        initialItems={[{ period: 1, subject: "数学", isHighlight: true }]}
      />,
    );
    expect(screen.getByLabelText("1 行目の重要マーク")).toBeChecked();
  });
});

describe("NoticeEditor 区切り線（§5.3）", () => {
  it("「＋区切り線」で divider 行が追加され kind:'divider' で保存される（ラベル空でも実体行）", async () => {
    render(<NoticeEditor classId={CLASS_ID} date={DATE} initialItems={[{ text: "連絡A" }]} />);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "＋区切り線" }));
    });
    await flushAutoSave();
    const saved = lastSaved<{ kind?: string; text: string }>(h.setNoticesAction);
    expect(saved).toEqual([{ text: "連絡A" }, { kind: "divider", text: "" }]);
  });

  it("divider 行も詳細パネルで表示日数を選べ、displayDays として保存される（§5.3 MEDIUM-1）", async () => {
    // 「区切り線も通常の連絡行と同じライフサイクルを持つ」＝多日連絡のグルーピングが翌日崩れない。
    render(
      <NoticeEditor
        classId={CLASS_ID}
        date={DATE}
        initialItems={[{ kind: "divider", text: "校訓" }]}
      />,
    );
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "1 件目の詳細項目" }));
    });
    act(() => {
      fireEvent.change(screen.getByLabelText("1 件目の表示日数"), { target: { value: "7" } });
    });
    await flushAutoSave();
    const saved = lastSaved<{ kind?: string; text: string; displayDays?: number }>(
      h.setNoticesAction,
    );
    expect(saved).toEqual([{ kind: "divider", text: "校訓", displayDays: 7 }]);
  });

  it("displayDays 付き divider の初期値は詳細が最初から開く（設定済みを隠さない）", () => {
    render(
      <NoticeEditor
        classId={CLASS_ID}
        date={DATE}
        initialItems={[{ kind: "divider", text: "校訓", displayDays: 3 }]}
      />,
    );
    expect((screen.getByLabelText("1 件目の表示日数") as HTMLSelectElement).value).toBe("3");
  });

  it("divider 行は ↑ で並べ替えでき、配列位置がそのまま保存される", async () => {
    render(
      <NoticeEditor
        classId={CLASS_ID}
        date={DATE}
        initialItems={[{ text: "連絡A" }, { kind: "divider", text: "校訓" }, { text: "連絡B" }]}
      />,
    );
    act(() => {
      fireEvent.keyDown(screen.getByRole("button", { name: "2 件目を並べ替え" }), {
        key: "ArrowUp",
      });
    });
    await flushAutoSave();
    const saved = lastSaved<{ kind?: string; text: string }>(h.setNoticesAction);
    expect(saved).toEqual([
      { kind: "divider", text: "校訓" },
      { text: "連絡A" },
      { text: "連絡B" },
    ]);
  });
});

describe("AssignmentEditor ⠿並べ替え / ★重要（§5.1 / §5.2）", () => {
  const sameDeadline: AssignmentItem[] = [
    { deadline: "2026-07-10", subject: "数学", task: "P30" },
    { deadline: "2026-07-10", subject: "国語", task: "音読" },
  ];

  it("同一期限内の ↑ 移動が保存順に反映される", async () => {
    render(<AssignmentEditor classId={CLASS_ID} date={DATE} initialItems={sameDeadline} />);
    act(() => {
      fireEvent.keyDown(screen.getByRole("button", { name: "2 件目を並べ替え" }), {
        key: "ArrowUp",
      });
    });
    await flushAutoSave();
    const saved = lastSaved<AssignmentItem>(h.setAssignmentsAction);
    expect(saved.map((a) => a.subject)).toEqual(["国語", "数学"]);
  });

  it("別期限へ跨いだ移動はスナップバック（期限昇順の意味論を壊さない＝保存も走らない）", async () => {
    render(
      <AssignmentEditor
        classId={CLASS_ID}
        date={DATE}
        initialItems={[
          { deadline: "2026-07-08", subject: "数学", task: "P30" },
          { deadline: "2026-07-10", subject: "国語", task: "音読" },
        ]}
      />,
    );
    act(() => {
      fireEvent.keyDown(screen.getByRole("button", { name: "2 件目を並べ替え" }), {
        key: "ArrowUp",
      });
    });
    await flushAutoSave();
    expect(h.setAssignmentsAction).not.toHaveBeenCalled();
  });

  it("詳細パネルの重要チェックが isHighlight:true で保存される", async () => {
    render(
      <AssignmentEditor
        classId={CLASS_ID}
        date={DATE}
        initialItems={[{ deadline: "2026-07-10", subject: "数学", task: "P30" }]}
      />,
    );
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "1 件目の詳細項目" }));
    });
    act(() => {
      fireEvent.click(screen.getByLabelText("1 件目の重要マーク"));
    });
    await flushAutoSave();
    const saved = lastSaved<AssignmentItem>(h.setAssignmentsAction);
    expect(saved).toEqual([
      { deadline: "2026-07-10", subject: "数学", task: "P30", isHighlight: true },
    ]);
  });
});

describe("resortFilledRows（事前生成の空行は位置を保持して実入力行だけ再ソート）", () => {
  it("空行スロットを動かさず、実入力行だけを安定ソートして元スロットへ戻す", () => {
    const rows = ["b", "", "a", ""];
    const out = resortFilledRows(
      rows,
      (r) => r === "",
      (filled) => [...filled].sort(),
    );
    expect(out).toEqual(["a", "", "b", ""]);
  });
});
