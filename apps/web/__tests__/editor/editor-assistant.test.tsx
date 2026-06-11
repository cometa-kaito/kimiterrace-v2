import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NoticeDraftEvent } from "../../lib/editor/notice-draft-client";

/**
 * 段C+（#243 ②UI-UX, ADR-033）: 新 EditorAssistant（ストリーミング・カード UI）のコンポーネント検証。
 * streamNoticeDraft / setNoticesAction / 音声 hook をモックし、ストリーミング表示・項目ごと採否・編集・
 * 反映（setNoticesAction）・エラー時のカード保持・pii_warning・redacted 件数表示を固める。
 */

const h = vi.hoisted(() => ({
  streamNoticeDraft: vi.fn(),
  setNoticesAction: vi.fn(),
  fileAction: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("@/lib/editor/notice-draft-client", () => ({
  streamNoticeDraft: (...a: unknown[]) => h.streamNoticeDraft(...a),
}));
vi.mock("@/lib/editor/notice-assignment-actions", () => ({
  setNoticesAction: (...a: unknown[]) => h.setNoticesAction(...a),
  setAssignmentsAction: vi.fn(),
}));
vi.mock("@/lib/editor/schedule-actions", () => ({ setScheduleAction: vi.fn() }));
vi.mock("@/lib/editor/assistant-actions", () => ({
  assistDraftNoticesFromFileAction: (...a: unknown[]) => h.fileAction(...a),
  // SectionDraftPanel（予定/提出物タブ）が transitive に import するため stub を置く（連絡テストでは未使用）。
  assistDraftScheduleAction: vi.fn(),
  assistDraftScheduleFromFileAction: vi.fn(),
  assistDraftAssignmentAction: vi.fn(),
  assistDraftAssignmentFromFileAction: vi.fn(),
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

import { EditorAssistant } from "../../app/admin/editor/_components/EditorAssistant";

const CLASS_ID = "11111111-1111-4111-8111-111111111111";

/** events を順に yield する async generator（streamNoticeDraft の戻り）。 */
function gen(events: NoticeDraftEvent[]): AsyncGenerator<NoticeDraftEvent> {
  return (async function* () {
    for (const e of events) yield e;
  })();
}

function renderPanel(existingNotices: { text: string; isHighlight?: boolean }[] = []) {
  return render(
    <EditorAssistant
      scope="class"
      targetId={CLASS_ID}
      date="2026-06-08"
      existingNotices={existingNotices}
    />,
  );
}

/** パネルを開いてメモを入力し「AIで連絡を作る」を押す（user-event は未導入ゆえ fireEvent）。 */
function openAndGenerate(memo = "明日は短縮授業") {
  fireEvent.click(screen.getByRole("button", { name: "AIアシスタントを開く" }));
  fireEvent.change(screen.getByPlaceholderText(/短縮授業/), { target: { value: memo } });
  fireEvent.click(screen.getByRole("button", { name: "AIで連絡を作る" }));
}

beforeEach(() => {
  h.streamNoticeDraft.mockReset();
  h.setNoticesAction.mockReset().mockResolvedValue({ ok: true });
  h.fileAction.mockReset();
  h.refresh.mockReset();
});
afterEach(() => cleanup());

describe("EditorAssistant（ストリーミング・カード UI）", () => {
  it("生成すると連絡が 1 件ずつカードに反映される", async () => {
    h.streamNoticeDraft.mockReturnValue(
      gen([
        { type: "notice", index: 0, text: "明日は短縮授業です。", isHighlight: false },
        { type: "notice", index: 1, text: "図書室の返却は金曜まで。", isHighlight: true },
        { type: "done", count: 2 },
      ]),
    );
    renderPanel();
    openAndGenerate();

    expect(await screen.findByDisplayValue("明日は短縮授業です。")).toBeInTheDocument();
    expect(screen.getByDisplayValue("図書室の返却は金曜まで。")).toBeInTheDocument();
    expect(screen.getByText("採用 2 / 2 件")).toBeInTheDocument();
  });

  it("トーンチップは同じメモを tone 付きで再生成する", async () => {
    // 生成 + 再生成で 2 回ストリームするため、呼び出しごとに新しいジェネレータを返す。
    h.streamNoticeDraft.mockImplementation(() =>
      gen([
        { type: "notice", index: 0, text: "連絡A", isHighlight: false },
        { type: "done", count: 1 },
      ]),
    );
    renderPanel();
    openAndGenerate();
    await screen.findByDisplayValue("連絡A");

    fireEvent.click(screen.getByRole("button", { name: "短く" }));

    await waitFor(() => expect(h.streamNoticeDraft).toHaveBeenCalledTimes(2));
    expect(h.streamNoticeDraft.mock.calls[1]?.[0]).toMatchObject({
      text: "明日は短縮授業",
      tone: "short",
    });
  });

  it("自由指示は instruction 付きで再生成する", async () => {
    h.streamNoticeDraft.mockImplementation(() =>
      gen([
        { type: "notice", index: 0, text: "連絡A", isHighlight: false },
        { type: "done", count: 1 },
      ]),
    );
    renderPanel();
    openAndGenerate();
    await screen.findByDisplayValue("連絡A");

    fireEvent.change(screen.getByLabelText("加筆・修正の指示"), {
      target: { value: "部活も足して" },
    });
    fireEvent.click(screen.getByRole("button", { name: "この指示で作り直す" }));

    await waitFor(() => expect(h.streamNoticeDraft).toHaveBeenCalledTimes(2));
    expect(h.streamNoticeDraft.mock.calls[1]?.[0]).toMatchObject({
      text: "明日は短縮授業",
      instruction: "部活も足して",
    });
  });

  it("反映すると既存連絡 + 採用カードで setNoticesAction を呼ぶ", async () => {
    h.streamNoticeDraft.mockReturnValue(
      gen([
        { type: "notice", index: 0, text: "連絡A", isHighlight: false },
        { type: "notice", index: 1, text: "連絡B", isHighlight: true },
        { type: "done", count: 2 },
      ]),
    );
    renderPanel([{ text: "既存" }]);
    openAndGenerate();
    await screen.findByDisplayValue("連絡A");

    fireEvent.click(screen.getByRole("button", { name: /連絡に反映する/ }));

    await waitFor(() => expect(h.setNoticesAction).toHaveBeenCalledOnce());
    const args = h.setNoticesAction.mock.calls[0];
    expect(args?.[0]).toBe("class");
    expect(args?.[1]).toBe(CLASS_ID);
    expect(args?.[3]).toEqual([
      { text: "既存" },
      { text: "連絡A" },
      { text: "連絡B", isHighlight: true },
    ]);
    expect(h.refresh).toHaveBeenCalled();
  });

  it("採用を外したカードは反映に含めない", async () => {
    h.streamNoticeDraft.mockReturnValue(
      gen([
        { type: "notice", index: 0, text: "残す", isHighlight: false },
        { type: "notice", index: 1, text: "外す", isHighlight: false },
        { type: "done", count: 2 },
      ]),
    );
    renderPanel();
    openAndGenerate();
    await screen.findByDisplayValue("残す");

    // 2 件目のカードの採用トグルを押して外す。
    const toggles = screen.getAllByRole("button", { name: "✓ 採用" });
    fireEvent.click(toggles[1] as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: /連絡に反映する/ }));

    await waitFor(() => expect(h.setNoticesAction).toHaveBeenCalledOnce());
    expect(h.setNoticesAction.mock.calls[0]?.[3]).toEqual([{ text: "残す" }]);
  });

  it("ストリーム途中の失敗でも既送出カードと入力を保持する", async () => {
    h.streamNoticeDraft.mockReturnValue(
      gen([
        { type: "notice", index: 0, text: "先に出た連絡", isHighlight: false },
        { type: "error", status: 500, reason: "stream_failed" },
      ]),
    );
    renderPanel();
    openAndGenerate();

    expect(await screen.findByDisplayValue("先に出た連絡")).toBeInTheDocument();
    expect(screen.getByText(/応答の生成に失敗/)).toBeInTheDocument();
    // 入力は保持される。
    expect(screen.getByPlaceholderText(/短縮授業/)).toHaveValue("明日は短縮授業");
  });

  it("pii_warning は警告と検出語を表示し、カードは出さない", async () => {
    h.streamNoticeDraft.mockReturnValue(
      gen([{ type: "error", status: 409, reason: "pii_warning", suspectedSurfaces: ["田中さん"] }]),
    );
    renderPanel();
    openAndGenerate("田中さんが欠席");

    const warn = await screen.findByText(/個人名らしき語/);
    expect(warn).toHaveTextContent("田中さん");
    expect(screen.getByRole("button", { name: "承知して続ける" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /連絡に反映する/ })).not.toBeInTheDocument();
  });

  it("除外された連絡（notice_redacted）の件数を表示する", async () => {
    h.streamNoticeDraft.mockReturnValue(
      gen([
        { type: "notice", index: 0, text: "通常の連絡", isHighlight: false },
        { type: "notice_redacted", index: 1 },
        { type: "done", count: 1 },
      ]),
    );
    renderPanel();
    openAndGenerate();

    expect(await screen.findByDisplayValue("通常の連絡")).toBeInTheDocument();
    expect(screen.getByText(/個人情報を含む可能性のある 1 件を除外/)).toBeInTheDocument();
  });
});
