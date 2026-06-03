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
    expect(mockStreamChat).toHaveBeenCalledWith({
      question: "文化祭の集合時間は？",
      endpoint: "/api/teacher/chat",
    });
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
      expect(mockStreamChat).toHaveBeenCalledWith({
        question: "やあ",
        endpoint: "/api/student/chat",
      }),
    );
  });
});
