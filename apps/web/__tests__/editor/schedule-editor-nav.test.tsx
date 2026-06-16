import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * ScheduleEditor の操作性改善（UI のみ・保存/検証/RLS/監査は無改変）を固定する。
 *
 * - 改善3: 対象日を変えると App Router 既定のページ先頭スクロールリセットを抑止するため
 *   `router.push(url, { scroll: false })` で遷移する（位置を保持）。`auto.flush()`→push の順序は維持。
 * - 改善4: 予定テーブルの Tab を**縦移動**（同じ列の次の行へ）にする。Shift+Tab は同じ列の前の行へ。
 *   最終行で Tab を押したら新規行を追加して同じ列にフォーカス（スプレッドシート風）。先頭行の Shift+Tab は
 *   既定動作に委ねる（フォーカストラップを作らない）。
 *
 * 自動保存フックは実物を走らせる（編集していない初期状態では保存は走らない）。Server Action は import 時に
 * DB/認可を引き込むため mock。
 */

const h = vi.hoisted(() => ({
  push: vi.fn(),
  setScheduleAction: vi.fn(async (..._a: unknown[]) => ({ ok: true as const })),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: h.push, refresh: vi.fn() }),
}));
vi.mock("@/lib/editor/schedule-actions", () => ({
  setScheduleAction: (...a: unknown[]) => h.setScheduleAction(...a),
}));

import { ScheduleEditor } from "../../app/app/editor/[classId]/_components/ScheduleEditor";
import type { ScheduleItem } from "../../lib/editor/schedule-core";

const CLASS_ID = "11111111-1111-1111-1111-111111111111";
const DATE = "2026-06-16";

function items(): ScheduleItem[] {
  return [
    { period: 1, subject: "数学" },
    { period: 2, subject: "国語" },
  ];
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ScheduleEditor 対象日切替（改善3: scroll 位置保持）", () => {
  it("対象日を変えると scroll:false 付きで push する（ページ先頭へ飛ばさない）", async () => {
    render(<ScheduleEditor classId={CLASS_ID} date={DATE} initialItems={items()} />);
    const dateInput = screen.getByLabelText("対象日") as HTMLInputElement;
    fireEvent.change(dateInput, { target: { value: "2026-06-17" } });
    // changeDate は async（flush を await しうる）。マイクロタスクを 1 つ流す。
    await Promise.resolve();
    expect(h.push).toHaveBeenCalledTimes(1);
    const call = h.push.mock.calls[0] as [string, unknown];
    expect(String(call[0])).toContain("date=2026-06-17");
    expect(call[1]).toEqual({ scroll: false });
  });
});

describe("ScheduleEditor Tab 縦移動（改善4）", () => {
  it("Tab で同じ列の次の行へフォーカスが移る（縦移動）", () => {
    render(<ScheduleEditor classId={CLASS_ID} date={DATE} initialItems={items()} />);
    const row0Subject = screen.getByLabelText("1 行目の科目名") as HTMLInputElement;
    const row1Subject = screen.getByLabelText("2 行目の科目名") as HTMLInputElement;
    row0Subject.focus();
    fireEvent.keyDown(row0Subject, { key: "Tab" });
    expect(document.activeElement).toBe(row1Subject);
  });

  it("Shift+Tab で同じ列の前の行へフォーカスが移る", () => {
    render(<ScheduleEditor classId={CLASS_ID} date={DATE} initialItems={items()} />);
    const row0Subject = screen.getByLabelText("1 行目の科目名") as HTMLInputElement;
    const row1Subject = screen.getByLabelText("2 行目の科目名") as HTMLInputElement;
    row1Subject.focus();
    fireEvent.keyDown(row1Subject, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(row0Subject);
  });

  it("最終行で Tab を押すと新規行が追加され同じ列にフォーカスが移る", () => {
    render(<ScheduleEditor classId={CLASS_ID} date={DATE} initialItems={items()} />);
    // 初期 2 行。2 行目の科目で Tab → 3 行目が追加され 3 行目の科目へ。
    const lastSubject = screen.getByLabelText("2 行目の科目名") as HTMLInputElement;
    lastSubject.focus();
    fireEvent.keyDown(lastSubject, { key: "Tab" });
    const newSubject = screen.getByLabelText("3 行目の科目名") as HTMLInputElement;
    expect(newSubject).toBeTruthy();
    expect(document.activeElement).toBe(newSubject);
  });

  it("先頭行の Shift+Tab はフォーカスを移さない（既定動作に委ねる＝preventDefault しない）", () => {
    render(<ScheduleEditor classId={CLASS_ID} date={DATE} initialItems={items()} />);
    const row0Subject = screen.getByLabelText("1 行目の科目名") as HTMLInputElement;
    row0Subject.focus();
    const ev = fireEvent.keyDown(row0Subject, { key: "Tab", shiftKey: true });
    // フォーカスは動かさない（ブラウザ既定のタブ順に任せる）。fireEvent はハンドラが
    // preventDefault しなければ true を返す。
    expect(ev).toBe(true);
    expect(document.activeElement).toBe(row0Subject);
  });

  it("時限 select の列でも Tab 縦移動が効く（列 0）", () => {
    render(<ScheduleEditor classId={CLASS_ID} date={DATE} initialItems={items()} />);
    const row0Slot = screen.getByLabelText("1 行目の時限") as HTMLSelectElement;
    const row1Slot = screen.getByLabelText("2 行目の時限") as HTMLSelectElement;
    row0Slot.focus();
    fireEvent.keyDown(row0Slot, { key: "Tab" });
    expect(document.activeElement).toBe(row1Slot);
  });
});
