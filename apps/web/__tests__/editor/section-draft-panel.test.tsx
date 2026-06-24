import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F02本丸 PR-3: SectionDraftPanel（予定/提出物の非ストリーミング AI ドラフト）のコンポーネント検証。
 * assist action / save action / 音声 hook をモックし、生成→カード編集→反映（既存+採用を save に渡す）・
 * pii_warning 表示・保存エラー表示を固める（SCHEDULE_DRAFT_CONFIG を代表に検証）。
 */

const h = vi.hoisted(() => ({
  scheduleAction: vi.fn(),
  scheduleFileAction: vi.fn(),
  setScheduleAction: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("@/lib/editor/assistant-actions", () => ({
  assistDraftScheduleAction: (...a: unknown[]) => h.scheduleAction(...a),
  assistDraftScheduleFromFileAction: (...a: unknown[]) => h.scheduleFileAction(...a),
  assistDraftAssignmentAction: vi.fn(),
  assistDraftAssignmentFromFileAction: vi.fn(),
}));
vi.mock("@/lib/editor/schedule-actions", () => ({
  setScheduleAction: (...a: unknown[]) => h.setScheduleAction(...a),
}));
vi.mock("@/lib/editor/notice-assignment-actions", () => ({ setAssignmentsAction: vi.fn() }));
vi.mock("@/lib/teacher-input/use-speech-to-text", () => ({
  useSpeechToText: () => ({
    supported: false,
    listening: false,
    transcript: "",
    interim: "",
    start: vi.fn(),
    stop: vi.fn(),
    reset: vi.fn(),
  }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: h.refresh }) }));

import {
  SCHEDULE_DRAFT_CONFIG,
  SectionDraftPanel,
} from "../../app/app/editor/_components/SectionDraftPanel";
import type { ScheduleItem } from "../../lib/editor/schedule-core";

const CLASS_ID = "11111111-1111-4111-8111-111111111111";

function renderSchedule(existing: ScheduleItem[] = []) {
  return render(
    <SectionDraftPanel
      scope="class"
      targetId={CLASS_ID}
      date="2026-06-08"
      existing={existing}
      config={SCHEDULE_DRAFT_CONFIG}
    />,
  );
}

function generate(memo: string) {
  fireEvent.change(screen.getByPlaceholderText(/1限は数学/), { target: { value: memo } });
  fireEvent.click(screen.getByRole("button", { name: "AIで予定を作る" }));
}

beforeEach(() => {
  h.scheduleAction.mockReset();
  h.scheduleFileAction.mockReset();
  h.setScheduleAction.mockReset().mockResolvedValue({ ok: true, data: { id: "x" } });
  h.refresh.mockReset();
});
afterEach(() => cleanup());

describe("SectionDraftPanel（予定）", () => {
  it("生成→カード表示→反映で『既存 + 採用』を setScheduleAction に渡す", async () => {
    h.scheduleAction.mockResolvedValue({
      ok: true,
      schedules: [
        { period: 1, subject: "数学" },
        { period: 2, subject: "英語", location: "体育館" },
      ],
    });
    renderSchedule([{ period: 3, subject: "理科" }]);
    generate("1限数学 2限英語 体育館");

    expect(await screen.findByDisplayValue("数学")).toBeInTheDocument();
    expect(screen.getByText("採用 2 / 2 件")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /予定に反映する/ }));
    await waitFor(() => expect(h.setScheduleAction).toHaveBeenCalledOnce());
    const args = h.setScheduleAction.mock.calls[0];
    expect(args?.[0]).toBe("class");
    expect(args?.[1]).toBe(CLASS_ID);
    expect(args?.[3]).toEqual([
      { period: 3, subject: "理科" },
      { period: 1, subject: "数学" },
      { period: 2, subject: "英語", location: "体育館" },
    ]);
    expect(h.refresh).toHaveBeenCalled();
  });

  it("カードを編集（科目）すると反映値に乗る", async () => {
    h.scheduleAction.mockResolvedValue({ ok: true, schedules: [{ period: 1, subject: "数学" }] });
    renderSchedule();
    generate("1限数学");
    await screen.findByDisplayValue("数学");

    fireEvent.change(screen.getByDisplayValue("数学"), { target: { value: "数学A" } });
    fireEvent.click(screen.getByRole("button", { name: /予定に反映する/ }));

    await waitFor(() => expect(h.setScheduleAction).toHaveBeenCalledOnce());
    expect(h.setScheduleAction.mock.calls[0]?.[3]).toEqual([{ period: 1, subject: "数学A" }]);
  });

  it("採用を外したカードは反映に含めない", async () => {
    h.scheduleAction.mockResolvedValue({
      ok: true,
      schedules: [
        { period: 1, subject: "残す" },
        { period: 2, subject: "外す" },
      ],
    });
    renderSchedule();
    generate("1限残す 2限外す");
    await screen.findByDisplayValue("残す");

    const toggles = screen.getAllByRole("button", { name: "✓ 採用" });
    fireEvent.click(toggles[1] as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: /予定に反映する/ }));

    await waitFor(() => expect(h.setScheduleAction).toHaveBeenCalledOnce());
    expect(h.setScheduleAction.mock.calls[0]?.[3]).toEqual([{ period: 1, subject: "残す" }]);
  });

  it("pii_warning は警告と検出語を表示し、カード/反映は出さない", async () => {
    h.scheduleAction.mockResolvedValue({
      ok: false,
      reason: "pii_warning",
      suspectedSurfaces: ["田中先生"],
    });
    renderSchedule();
    generate("田中先生の数学");

    const warn = await screen.findByText(/個人名らしき語/);
    expect(warn).toHaveTextContent("田中先生");
    expect(screen.getByRole("button", { name: "承知して続ける" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /予定に反映する/ })).not.toBeInTheDocument();
  });

  it("保存アクションのエラーはメッセージを表示する（検証は action 側が最終強制）", async () => {
    h.scheduleAction.mockResolvedValue({ ok: true, schedules: [{ period: 1, subject: "数学" }] });
    h.setScheduleAction.mockResolvedValue({
      ok: false,
      error: { code: "invalid", message: "時限 1 が重複しています。" },
    });
    renderSchedule();
    generate("1限数学");
    await screen.findByDisplayValue("数学");

    fireEvent.click(screen.getByRole("button", { name: /予定に反映する/ }));
    await waitFor(() => expect(screen.getByText("時限 1 が重複しています。")).toBeInTheDocument());
  });

  it("生成結果が no_result ならメッセージ（カードなし）", async () => {
    h.scheduleAction.mockResolvedValue({ ok: false, reason: "no_result" });
    renderSchedule();
    generate("わからない");
    await waitFor(() => expect(screen.getByText(/うまく作成できませんでした/)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /予定に反映する/ })).not.toBeInTheDocument();
  });

  // 時限の select（時限なし / 自由入力）が本体 ScheduleEditor と揃っているか。period が任意化された後
  // （PR #1192）、AI 下書きが period を持たない要素を出しても select が壊れず、時限を外して反映できること。
  it("period 無しの下書きは『（時限なし）』を選択表示し、反映で period を載せない", async () => {
    h.scheduleAction.mockResolvedValue({ ok: true, schedules: [{ subject: "自習" }] });
    renderSchedule();
    generate("自習");
    await screen.findByDisplayValue("自習");

    // String(undefined)="undefined" でどの option にも一致しない崩れ → 空（時限なし）に倒れていること。
    const slot = screen.getByLabelText("時限") as HTMLSelectElement;
    expect(slot.value).toBe("");

    fireEvent.click(screen.getByRole("button", { name: /予定に反映する/ }));
    await waitFor(() => expect(h.setScheduleAction).toHaveBeenCalledOnce());
    expect(h.setScheduleAction.mock.calls[0]?.[3]).toEqual([{ subject: "自習" }]);
  });

  it("時限ありの下書きで『（時限なし）』を選ぶと period を外して反映する", async () => {
    h.scheduleAction.mockResolvedValue({ ok: true, schedules: [{ period: 1, subject: "数学" }] });
    renderSchedule();
    generate("1限数学");
    await screen.findByDisplayValue("数学");

    fireEvent.change(screen.getByLabelText("時限"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /予定に反映する/ }));

    await waitFor(() => expect(h.setScheduleAction).toHaveBeenCalledOnce());
    expect(h.setScheduleAction.mock.calls[0]?.[3]).toEqual([{ subject: "数学" }]);
  });

  it("『その他』を選ぶと自由入力欄が出て、入力した時限ラベルが反映に乗る", async () => {
    h.scheduleAction.mockResolvedValue({ ok: true, schedules: [{ period: 1, subject: "数学" }] });
    renderSchedule();
    generate("1限数学");
    await screen.findByDisplayValue("数学");

    fireEvent.change(screen.getByLabelText("時限"), { target: { value: "__custom__" } });
    const custom = await screen.findByLabelText("時限（自由入力）");
    fireEvent.change(custom, { target: { value: "補習" } });
    fireEvent.click(screen.getByRole("button", { name: /予定に反映する/ }));

    await waitFor(() => expect(h.setScheduleAction).toHaveBeenCalledOnce());
    expect(h.setScheduleAction.mock.calls[0]?.[3]).toEqual([
      { period: { custom: "補習" }, subject: "数学" },
    ]);
  });
});
