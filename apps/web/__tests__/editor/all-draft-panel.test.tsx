import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F02本丸 PR-6b: AllDraftPanel（おまかせ＝1入力→AI分類→予定/連絡/提出物 同時提案）の検証。
 * assistDraftAllAction + per-section save action + 音声 hook をモックし、生成→3グループ表示→反映で
 * 各 save を「既存+採用」で呼ぶこと・部分失敗の明示報告・pii_warning を固める（ADR-036）。
 */

const h = vi.hoisted(() => ({
  allAction: vi.fn(),
  allFileAction: vi.fn(),
  setSchedule: vi.fn(),
  setNotices: vi.fn(),
  setAssignments: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("@/lib/editor/assistant-actions", () => ({
  assistDraftAllAction: (...a: unknown[]) => h.allAction(...a),
  assistDraftAllFromFileAction: (...a: unknown[]) => h.allFileAction(...a),
  // AllDraftPanel が import する SectionDraftPanel の config が transitive に参照する stub。
  assistDraftScheduleAction: vi.fn(),
  assistDraftScheduleFromFileAction: vi.fn(),
  assistDraftAssignmentAction: vi.fn(),
  assistDraftAssignmentFromFileAction: vi.fn(),
}));
vi.mock("@/lib/editor/schedule-actions", () => ({
  setScheduleAction: (...a: unknown[]) => h.setSchedule(...a),
}));
vi.mock("@/lib/editor/notice-assignment-actions", () => ({
  setNoticesAction: (...a: unknown[]) => h.setNotices(...a),
  setAssignmentsAction: (...a: unknown[]) => h.setAssignments(...a),
}));
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

import { AllDraftPanel } from "../../app/app/editor/_components/AllDraftPanel";

const CLASS_ID = "11111111-1111-4111-8111-111111111111";

function renderPanel(
  existing: {
    schedules?: { period: number; subject: string }[];
    notices?: { text: string }[];
    assignments?: { deadline: string; subject: string; task: string }[];
  } = {},
) {
  return render(
    <AllDraftPanel
      scope="class"
      targetId={CLASS_ID}
      date="2026-06-08"
      existingSchedules={existing.schedules ?? []}
      existingNotices={existing.notices ?? []}
      existingAssignments={existing.assignments ?? []}
    />,
  );
}

function generate(memo: string) {
  fireEvent.change(screen.getByPlaceholderText(/全校集会/), { target: { value: memo } });
  fireEvent.click(screen.getByRole("button", { name: "AIにおまかせで作る" }));
}

const FULL = {
  ok: true as const,
  schedules: [{ period: 1, subject: "数学" }],
  notices: [{ text: "全校集会があります" }],
  assignments: [{ deadline: "2026-06-20", subject: "英語", task: "ワークP30" }],
};

beforeEach(() => {
  h.allAction.mockReset();
  h.allFileAction.mockReset();
  h.setSchedule.mockReset().mockResolvedValue({ ok: true, data: { id: "s" } });
  h.setNotices.mockReset().mockResolvedValue({ ok: true, data: { id: "n" } });
  h.setAssignments.mockReset().mockResolvedValue({ ok: true, data: { id: "a" } });
  h.refresh.mockReset();
});
afterEach(() => cleanup());

describe("AllDraftPanel（おまかせ統合）", () => {
  it("生成すると予定/連絡/提出物の3グループが出る", async () => {
    h.allAction.mockResolvedValue(FULL);
    renderPanel();
    generate("1限数学 全校集会 数学ワーク20日まで");

    expect(await screen.findByDisplayValue("数学")).toBeInTheDocument(); // 予定 subject
    expect(screen.getByDisplayValue("全校集会があります")).toBeInTheDocument(); // 連絡 text
    expect(screen.getByDisplayValue("ワークP30")).toBeInTheDocument(); // 提出物 内容
    expect(screen.getByText("反映する（3）")).toBeInTheDocument();
  });

  it("反映で 3 セクションそれぞれ『既存 + 採用』を save に渡し refresh する", async () => {
    h.allAction.mockResolvedValue(FULL);
    renderPanel({
      schedules: [{ period: 5, subject: "理科" }],
      notices: [{ text: "既存連絡" }],
      assignments: [{ deadline: "2026-06-10", subject: "国語", task: "音読" }],
    });
    generate("memo");
    await screen.findByDisplayValue("数学");

    fireEvent.click(screen.getByRole("button", { name: /反映する/ }));

    await waitFor(() => expect(h.setSchedule).toHaveBeenCalledOnce());
    expect(h.setSchedule.mock.calls[0]?.[3]).toEqual([
      { period: 5, subject: "理科" },
      { period: 1, subject: "数学" },
    ]);
    expect(h.setNotices.mock.calls[0]?.[3]).toEqual([
      { text: "既存連絡" },
      { text: "全校集会があります" },
    ]);
    expect(h.setAssignments.mock.calls[0]?.[3]).toEqual([
      { deadline: "2026-06-10", subject: "国語", task: "音読" },
      { deadline: "2026-06-20", subject: "英語", task: "ワークP30" },
    ]);
    expect(h.refresh).toHaveBeenCalled();
  });

  it("採用が無いセクションは save を呼ばない（連絡のみ採用）", async () => {
    h.allAction.mockResolvedValue(FULL);
    renderPanel();
    generate("memo");
    await screen.findByDisplayValue("数学");

    // 予定・提出物の採用を外す（連絡だけ残す）。採用トグルはグループ順 [予定, 連絡, 提出物]。
    const toggles = screen.getAllByRole("button", { name: "✓ 採用" });
    fireEvent.click(toggles[0] as HTMLElement); // 予定を外す
    fireEvent.click(toggles[2] as HTMLElement); // 提出物を外す
    fireEvent.click(screen.getByRole("button", { name: /反映する/ }));

    await waitFor(() => expect(h.setNotices).toHaveBeenCalledOnce());
    expect(h.setSchedule).not.toHaveBeenCalled();
    expect(h.setAssignments).not.toHaveBeenCalled();
  });

  it("部分失敗は『一部のみ反映』と失敗セクションを明示する（他は反映済・ADR-036）", async () => {
    h.allAction.mockResolvedValue(FULL);
    h.setNotices.mockResolvedValue({
      ok: false,
      error: { code: "invalid", message: "連絡の本文は 1〜500 文字で入力してください。" },
    });
    renderPanel();
    generate("memo");
    await screen.findByDisplayValue("数学");

    fireEvent.click(screen.getByRole("button", { name: /反映する/ }));

    await waitFor(() => expect(screen.getByText(/一部のみ反映しました/)).toBeInTheDocument());
    expect(screen.getByText(/連絡の本文は/)).toBeInTheDocument();
    // 失敗があっても予定・提出物の保存は実行される（順次・非原子）。
    expect(h.setSchedule).toHaveBeenCalledOnce();
    expect(h.setAssignments).toHaveBeenCalledOnce();
    expect(h.refresh).toHaveBeenCalled();
  });

  it("pii_warning は警告を表示し、グループ/反映は出さない", async () => {
    h.allAction.mockResolvedValue({
      ok: false,
      reason: "pii_warning",
      suspectedSurfaces: ["田中先生"],
    });
    renderPanel();
    generate("田中先生の数学");

    const warn = await screen.findByText(/個人名らしき語/);
    expect(warn).toHaveTextContent("田中先生");
    expect(screen.queryByRole("button", { name: /反映する/ })).not.toBeInTheDocument();
  });

  it("no_result はメッセージのみ（グループなし）", async () => {
    h.allAction.mockResolvedValue({ ok: false, reason: "no_result" });
    renderPanel();
    generate("わからない");
    await waitFor(() => expect(screen.getByText(/うまく作成できませんでした/)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /反映する/ })).not.toBeInTheDocument();
  });
});
