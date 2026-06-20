import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * EditorChat の **反映（保存）挙動**を固定する。特に「編集 / 削除」が盤面に反映されることを担保する。
 *
 * 会話 AI は盤面でシードした『完全な目標状態』を下書きとして返し、反映は per-section の置換保存で盤面を
 * 下書きに一致させる（空配列の保存 = 当該セクションの全消去）。旧実装は `onApply` が空セクションを常に
 * スキップし、かつ下書きが空だと確認カードを出さなかったため、**削除が反映できない**バグがあった
 * （ユーザー報告: 「連絡を削除して」→「削除しました」→ 反映できず「承知いたしました」ループ）。本テストは:
 *  - 盤面に連絡があり下書きが空（= 削除指示）のとき、確認カードと「連絡をすべて削除します」予告が出る
 *  - 「反映する」で `setNoticesAction(..., [])`（全消去）が呼ばれる
 *  - 盤面 / 下書きとも空のセクション（schedules / assignments）は触らない（無駄な空置換をしない）
 *  - 追加（空盤面 + 下書きに連絡）も従来どおり当該セクションだけ保存する（回帰ガード）
 * を固定する。SSE は本物のネットワークに出さず、fetch を ReadableStream の synthetic フレームで stub する。
 */

const mockStt = vi.hoisted(() => ({
  supported: false,
  listening: false,
  transcript: "",
  interim: "",
  error: null as string | null,
  start: vi.fn(),
  stop: vi.fn(),
  reset: vi.fn(),
}));
vi.mock("../../lib/teacher-input/use-speech-to-text", () => ({
  useSpeechToText: () => mockStt,
}));

vi.mock("../../lib/editor/notice-assignment-actions", () => ({
  setNoticesAction: vi.fn(async () => ({ ok: true, data: { id: "d1" } })),
  setAssignmentsAction: vi.fn(async () => ({ ok: true, data: { id: "d1" } })),
}));
vi.mock("../../lib/editor/schedule-actions", () => ({
  setScheduleAction: vi.fn(async () => ({ ok: true, data: { id: "d1" } })),
}));
vi.mock("../../lib/editor/assistant-actions", () => ({ assistDraftAllFromFileAction: vi.fn() }));

import { EditorChat } from "../../app/app/editor/_components/EditorChat";
import type { AssistantDraft } from "../../lib/editor/assistant-chat-core";
import { setAssignmentsAction, setNoticesAction } from "../../lib/editor/notice-assignment-actions";
import { setScheduleAction } from "../../lib/editor/schedule-actions";

/** synthetic SSE Response（meta → draft → done）を 1 ターン分返す fetch stub を張る。 */
function stubSse(finalDraft: AssistantDraft, allowed = ["schedules", "notices", "assignments"]) {
  const frames = [
    `event: meta\ndata: ${JSON.stringify({ pattern: "pattern1", allowedSections: allowed })}\n\n`,
    `event: draft\ndata: ${JSON.stringify(finalDraft)}\n\n`,
    `event: message\ndata: ${JSON.stringify({ delta: "承知しました。" })}\n\n`,
    `event: done\ndata: ${JSON.stringify({ draft: finalDraft })}\n\n`,
  ];
  const fetchMock = vi.fn(async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const f of frames) {
          controller.enqueue(encoder.encode(f));
        }
        controller.close();
      },
    });
    return { ok: true, body } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function send(text: string) {
  const input = screen.getByPlaceholderText(/Enter で送信/) as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: "Enter" });
}

beforeEach(() => {
  vi.mocked(setNoticesAction).mockClear();
  vi.mocked(setAssignmentsAction).mockClear();
  vi.mocked(setScheduleAction).mockClear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("EditorChat 反映（編集 / 削除対応）", () => {
  it("盤面の連絡を全削除（下書き空）でも確認カードが出て、反映で連絡が空配列で保存される", async () => {
    // 盤面の現状 = 連絡が 1 件（予定 / 提出物は無し）。
    stubSse({ schedules: [], notices: [], assignments: [] });
    render(
      <EditorChat
        scope="class"
        targetId="c1"
        date="2026-06-20"
        initialDraft={{ schedules: [], notices: [{ text: "既存の連絡" }], assignments: [] }}
      />,
    );

    send("連絡を削除して");

    // 下書きが空でも確認カードが出る（旧実装は出なかった）。何が消えるかも予告する。
    const applyBtn = await screen.findByRole("button", { name: "反映する" });
    expect(screen.getByText("連絡をすべて削除します。")).toBeTruthy();

    fireEvent.click(applyBtn);

    await screen.findByText("盤面に反映しました。");
    // 連絡は空配列で置換保存 = 全消去。
    expect(setNoticesAction).toHaveBeenCalledTimes(1);
    expect(setNoticesAction).toHaveBeenCalledWith("class", "c1", "2026-06-20", []);
    // 盤面 / 下書きとも空の予定・提出物は触らない（無駄な空置換をしない）。
    expect(setScheduleAction).not.toHaveBeenCalled();
    expect(setAssignmentsAction).not.toHaveBeenCalled();
  });

  it("追加（空盤面 + 下書きに連絡）は従来どおり連絡だけ保存する（回帰ガード）", async () => {
    stubSse({ schedules: [], notices: [{ text: "明日は避難訓練です。" }], assignments: [] });
    render(<EditorChat scope="class" targetId="c1" date="2026-06-20" initialDraft={undefined} />);

    send("明日避難訓練があります");

    const applyBtn = await screen.findByRole("button", { name: "反映する" });
    // 追加なので削除予告は出ない。
    expect(screen.queryByText(/をすべて削除します。/)).toBeNull();

    fireEvent.click(applyBtn);

    await screen.findByText("盤面に反映しました。");
    expect(setNoticesAction).toHaveBeenCalledTimes(1);
    expect(setNoticesAction).toHaveBeenCalledWith("class", "c1", "2026-06-20", [
      { text: "明日は避難訓練です。" },
    ]);
    expect(setScheduleAction).not.toHaveBeenCalled();
    expect(setAssignmentsAction).not.toHaveBeenCalled();
  });

  it("pattern2（許可=予定のみ）では、盤面の連絡が DB にあっても連絡を絶対に消さない（パターン外の全消去防止）", async () => {
    // pattern2 のクラス: 盤面に出るのは予定のみ。連絡は盤面に出ないが DB には残っている（page は全セクションを
    // seed する）。サーバは done の下書きを許可セクションに絞る（notices は []）。予定を編集して反映しても、
    // 許可外の連絡は per-section 保存の対象にしない＝消えてはならない。
    stubSse({ schedules: [{ period: 2, subject: "英語" }], notices: [], assignments: [] }, [
      "schedules",
    ]);
    render(
      <EditorChat
        scope="class"
        targetId="c1"
        date="2026-06-20"
        initialDraft={{
          schedules: [{ period: 1, subject: "数学" }],
          notices: [{ text: "盤面に出ない連絡" }],
          assignments: [],
        }}
      />,
    );

    send("2限を英語に");

    const applyBtn = await screen.findByRole("button", { name: "反映する" });
    // 許可外の連絡は削除予告にも出さない。
    expect(screen.queryByText(/をすべて削除します。/)).toBeNull();

    fireEvent.click(applyBtn);

    await screen.findByText("盤面に反映しました。");
    expect(setScheduleAction).toHaveBeenCalledTimes(1);
    expect(setScheduleAction).toHaveBeenCalledWith("class", "c1", "2026-06-20", [
      { period: 2, subject: "英語" },
    ]);
    // 連絡は許可セクション外 → 保存（= [] 置換）を絶対に呼ばない（DB の連絡は保全）。
    expect(setNoticesAction).not.toHaveBeenCalled();
    expect(setAssignmentsAction).not.toHaveBeenCalled();
  });

  it("空盤面への聞き返し（下書きも盤面も空）では確認カードを出さない", async () => {
    stubSse({ schedules: [], notices: [], assignments: [] });
    render(<EditorChat scope="class" targetId="c1" date="2026-06-20" initialDraft={undefined} />);

    send("数学の宿題を出して");

    // done に達しても、反映するものが無いので確認カードは出ない。
    await waitFor(() => expect(screen.getByText("承知しました。")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "反映する" })).toBeNull();
  });
});
