import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatEvent } from "../../lib/student-qa/chat-client";

// SSE クライアントを mock し、汎用 ChatPanel の prop 配線 (endpoint/文言) を決定的に検証 (ADR-012)。
vi.mock("../../lib/student-qa/chat-client", () => ({
  streamChat: vi.fn(),
}));

import { ChatPanel } from "../../app/_components/ChatPanel";
import { streamChat } from "../../lib/student-qa/chat-client";

const mockStreamChat = vi.mocked(streamChat);

function gen(events: ChatEvent[]): AsyncGenerator<ChatEvent> {
  return (async function* () {
    for (const e of events) yield e;
  })();
}

const TEACHER_PROPS = {
  endpoint: "/api/teacher/chat",
  heading: "掲示物 Q&A",
  placeholder: "例: 文化祭の集合時間はいつですか？",
  emptyHint: "自校の掲示物に関する質問を入力して送信してください。",
} as const;

describe("ChatPanel (F06 汎用チャット UI, #370/#371)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prop の heading / placeholder / emptyHint を描画する", () => {
    render(<ChatPanel {...TEACHER_PROPS} />);
    expect(screen.getByRole("heading", { name: "掲示物 Q&A" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("例: 文化祭の集合時間はいつですか？")).toBeInTheDocument();
    expect(
      screen.getByText("自校の掲示物に関する質問を入力して送信してください。"),
    ).toBeInTheDocument();
  });

  it("送信時に prop の endpoint で streamChat を呼ぶ (教員経路 = /api/teacher/chat)", async () => {
    mockStreamChat.mockReturnValue(
      gen([
        { type: "delta", text: "文化祭は10時集合です。" },
        { type: "done", sessionId: "s", messageId: "m" },
      ]),
    );
    render(<ChatPanel {...TEACHER_PROPS} />);
    const input = screen.getByLabelText("質問を入力") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "文化祭の集合時間は？" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    expect(await screen.findByText("文化祭は10時集合です。")).toBeInTheDocument();
    // endpoint が teacher 経路で渡る (生徒経路と取り違えない)。
    expect(mockStreamChat).toHaveBeenCalledWith(
      expect.objectContaining({
        question: "文化祭の集合時間は？",
        endpoint: "/api/teacher/chat",
      }),
    );
  });

  it("教員経路の forbidden/unauthenticated は magic_link 文言でなくアクセス権限エラーを表示する (#370 nit)", async () => {
    mockStreamChat.mockReturnValue(gen([{ type: "error", status: 403, reason: "forbidden" }]));
    render(<ChatPanel {...TEACHER_PROPS} />);
    const input = screen.getByLabelText("質問を入力") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "質問" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    const alert = await screen.findByRole("alert");
    // 教員に「担任の先生にリンク発行を依頼」は不適切。権限/再ログイン文言にする。
    expect(alert).toHaveTextContent(/アクセス権限がありません/);
    expect(alert).not.toHaveTextContent(/リンク/);
  });

  it("endpoint=/api/student/chat なら生徒経路で streamChat を呼ぶ (汎用性の確認)", async () => {
    mockStreamChat.mockReturnValue(gen([{ type: "done", sessionId: "s", messageId: "m" }]));
    render(
      <ChatPanel
        endpoint="/api/student/chat"
        heading="掲示物について質問する"
        placeholder="例"
        emptyHint="ヒント"
      />,
    );
    const input = screen.getByLabelText("質問を入力") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "やあ" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    await waitFor(() =>
      expect(mockStreamChat).toHaveBeenCalledWith(
        expect.objectContaining({
          question: "やあ",
          endpoint: "/api/student/chat",
        }),
      ),
    );
  });

  it("生成中は停止ボタンを出し、押すと streamChat の signal を abort する", async () => {
    // 1 delta 出した後に保留して streaming を継続させる（停止ボタンが出ている状態を作る）。
    let release: () => void = () => {};
    const hang = new Promise<void>((r) => {
      release = r;
    });
    mockStreamChat.mockReturnValue(
      (async function* () {
        yield { type: "delta", text: "途中まで" } as ChatEvent;
        await hang;
      })(),
    );
    render(<ChatPanel {...TEACHER_PROPS} />);
    const input = screen.getByLabelText("質問を入力") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "質問" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    expect(await screen.findByText("途中まで")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "停止" }));

    const arg = mockStreamChat.mock.calls[0]?.[0] as { signal?: AbortSignal } | undefined;
    expect(arg?.signal?.aborted).toBe(true);

    // クリーンアップ: 保留を解いてストリームを閉じ、停止ボタンが消えるまで待つ。
    release();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "停止" })).not.toBeInTheDocument(),
    );
  });
});
