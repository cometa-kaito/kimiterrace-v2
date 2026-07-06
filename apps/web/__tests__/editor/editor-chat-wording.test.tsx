import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * EditorChat の**誘導文言**（2026-07-06 実画面監査 P2 の 4 指摘）を固定する。表示層のみで、
 * 保存・SSE・反映ロジック（onApply / willWriteSection / rebaseDraftBeforeFirstTurn）には触れない。
 *
 *  1. 挨拶が編集対象日つき（「7/15（水）の盤面を作ります。…」）＝16 時カットオーバー後に「今日」が嘘になる是正
 *  2. 確認カード冒頭とボタンに反映先日付（「7/15（水）の盤面に反映します」「7/15（水）に反映」）。
 *     複数日（days）は日付ごとに反映するため従来表記（「N日分の下書きです」+「反映する」）を維持
 *  3. 「直す」押下後にアシスタント側の誘導ヒント（表示専用・messages に積まない）を出し、次の送信で消す
 *  4. 下書き行に場所 / 対象者 / 表示日数 / 重要★ を小さく併記（draftItemMeta・盤面整形は不変）
 *
 * SSE は editor-chat-apply.test.tsx と同じ synthetic フレームの fetch stub（実ネットワークに出さない）。
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

/** synthetic SSE Response（meta → draft → done）を返す fetch stub（呼び出しごとに新しいストリーム）。 */
function stubSse(finalDraft: AssistantDraft) {
  const frames = [
    `event: meta\ndata: ${JSON.stringify({ pattern: "pattern1", allowedSections: ["schedules", "notices", "assignments"] })}\n\n`,
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
  const input = screen.getByPlaceholderText(/話す・書く・ファイル/) as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: "Enter" });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("EditorChat 挨拶の対象日（P2-1）", () => {
  it("挨拶は編集対象日つき（date prop から整形・パターン別セクション列挙は維持）", () => {
    stubSse({ schedules: [], notices: [], assignments: [] });
    render(<EditorChat scope="class" targetId="c1" date="2026-07-15" initialDraft={undefined} />);

    expect(
      screen.getByText(
        "7/15（水）の盤面を作ります。話しかけてください。話す・書く・ファイルでOK。予定・連絡・提出物にまとめて下書きします。",
      ),
    ).toBeTruthy();
  });
});

describe("EditorChat 確認カードの反映先日付（P2-2）", () => {
  it("単一日: カード冒頭に「7/15（水）の盤面」・ボタンは「7/15（水）に反映」", async () => {
    stubSse({ schedules: [], notices: [{ text: "明日は避難訓練です。" }], assignments: [] });
    render(<EditorChat scope="class" targetId="c1" date="2026-07-15" initialDraft={undefined} />);

    send("明日避難訓練があります");

    expect(await screen.findByRole("button", { name: "7/15（水）に反映" })).toBeTruthy();
    // 反映先（太字部分）を冒頭に明示する。
    expect(screen.getByText("7/15（水）の盤面")).toBeTruthy();
    expect(screen.queryByText("下書きにまとめました。")).toBeNull();
  });

  it("複数日（days）: 従来の「N日分の下書きです」表記とボタン「反映する」を維持（単一日付を掲げない）", async () => {
    const draft: AssistantDraft = {
      schedules: [],
      notices: [],
      assignments: [],
      days: [
        {
          date: "2026-07-20",
          schedules: [{ period: 1, subject: "数学" }],
          notices: [],
          assignments: [],
        },
        {
          date: "2026-07-21",
          schedules: [{ period: 1, subject: "英語" }],
          notices: [],
          assignments: [],
        },
      ],
    };
    stubSse(draft);
    render(<EditorChat scope="class" targetId="c1" date="2026-07-15" initialDraft={undefined} />);

    send("来週の月火、1限を入れて");

    expect(await screen.findByRole("button", { name: "反映する" })).toBeTruthy();
    expect(screen.getByText("2日分の下書きです（日付ごとに反映します）。")).toBeTruthy();
    // 複数日に単一日付のボタン / 見出しを出すと嘘になるため出さない。
    expect(screen.queryByRole("button", { name: "7/15（水）に反映" })).toBeNull();
    expect(screen.queryByText("7/15（水）の盤面")).toBeNull();
  });
});

describe("EditorChat「直す」の誘導（P2-3）", () => {
  it("「直す」でカードを閉じた直後に誘導ヒントを出し、次の送信で消す（会話ログには積まない）", async () => {
    stubSse({ schedules: [], notices: [{ text: "明日は避難訓練です。" }], assignments: [] });
    render(<EditorChat scope="class" targetId="c1" date="2026-07-15" initialDraft={undefined} />);

    send("明日避難訓練があります");
    await screen.findByRole("button", { name: "7/15（水）に反映" });

    fireEvent.click(screen.getByRole("button", { name: "直す" }));

    // カードは閉じ、次の一手（修正内容を話す）の誘導が出る。
    expect(screen.queryByRole("button", { name: /に反映|反映する/ })).toBeNull();
    expect(
      screen.getByText("どこを直しますか？（例:「数学は3限に」「体育を消して」）"),
    ).toBeTruthy();

    // 次の送信でヒントは消える（表示専用＝会話には残らない）。
    send("避難訓練は3限に");
    await waitFor(() =>
      expect(
        screen.queryByText("どこを直しますか？（例:「数学は3限に」「体育を消して」）"),
      ).toBeNull(),
    );
  });
});

describe("EditorChat 下書きカードの詳細併記（P2-4）", () => {
  it("予定の場所 / 対象者 / ★・連絡の表示日数・提出物の★を小さく併記する（存在するもののみ）", async () => {
    stubSse({
      schedules: [
        {
          period: 2,
          subject: "理科",
          location: "理科室",
          targetAudience: "3年生",
          isHighlight: true,
        },
        { period: 3, subject: "国語" },
      ],
      notices: [{ text: "持久走大会があります", displayDays: 3 }],
      assignments: [
        { deadline: "2026-07-17", subject: "数学", task: "プリント", isHighlight: true },
      ],
    });
    render(<EditorChat scope="class" targetId="c1" date="2026-07-15" initialDraft={undefined} />);

    send("明日の予定と連絡");

    await screen.findByRole("button", { name: "7/15（水）に反映" });
    // 予定: 本文（formatSignageItem）は従来どおり・詳細は併記 span（draftItemMeta）。
    expect(screen.getByText("2限 理科")).toBeTruthy();
    expect(screen.getByText("＠理科室 対象: 3年生 ★")).toBeTruthy();
    // 詳細なしの行には併記を出さない（li 直下のテキストは本文のみ）。
    expect(screen.getByText("3限 国語")).toBeTruthy();
    // 連絡: 表示日数>1 を併記。
    expect(screen.getByText("持久走大会があります")).toBeTruthy();
    expect(screen.getByText("3日間表示")).toBeTruthy();
    // 提出物: 期限は本文（（〆7/17））・★は併記。
    expect(screen.getByText("数学：プリント（〆7/17）")).toBeTruthy();
    expect(screen.getByText("★")).toBeTruthy();
  });
});
