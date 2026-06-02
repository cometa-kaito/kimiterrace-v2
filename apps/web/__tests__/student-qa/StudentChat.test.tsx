import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatEvent } from "../../lib/student-qa/chat-client";

// SSE クライアントを mock し、コンポーネントの UX/状態遷移のみを決定的に検証 (ADR-012)。
// 実 SSE 解析は chat-client.test.ts、実 route は #372 E2E が担う。
vi.mock("../../lib/student-qa/chat-client", () => ({
  streamChat: vi.fn(),
}));

import { streamChat } from "../../lib/student-qa/chat-client";
import { StudentChat } from "../../app/student/_components/StudentChat";

const mockStreamChat = vi.mocked(streamChat);

/** 与えたイベント列を yield する async generator を返す。 */
function gen(events: ChatEvent[]): AsyncGenerator<ChatEvent> {
  return (async function* () {
    for (const e of events) yield e;
  })();
}

/** 送信ボタン / 入力欄のハンドル。 */
function ui() {
  return {
    input: screen.getByLabelText("質問を入力") as HTMLInputElement,
    send: screen.getByRole("button", { name: /送信/ }),
  };
}

async function ask(question: string) {
  const { input } = ui();
  fireEvent.change(input, { target: { value: question } });
  fireEvent.submit(input.closest("form") as HTMLFormElement);
}

describe("StudentChat (#371 生徒チャット UI)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("見出し・入力欄・送信ボタンを描画し、空入力では送信不可", () => {
    render(<StudentChat />);
    expect(screen.getByRole("heading", { name: "掲示物について質問する" })).toBeInTheDocument();
    expect(screen.getByLabelText("質問を入力")).toBeInTheDocument();
    expect(ui().send).toBeDisabled();
  });

  it("質問送信で生徒メッセージを表示し、delta を蓄積→done で assistant 確定、入力をクリア", async () => {
    mockStreamChat.mockReturnValue(
      gen([
        { type: "delta", text: "体育祭の" },
        { type: "delta", text: "持ち物は体操服です。" },
        { type: "done", sessionId: "s", messageId: "m" },
      ]),
    );
    render(<StudentChat />);
    await ask("体育祭の持ち物は？");

    expect(await screen.findByText("体育祭の持ち物は？")).toBeInTheDocument();
    expect(await screen.findByText("体育祭の持ち物は体操服です。")).toBeInTheDocument();
    // streamChat が正しい引数で呼ばれる (トークンは渡さない、cookie 認証経路 #371)。
    expect(mockStreamChat).toHaveBeenCalledWith({ question: "体育祭の持ち物は？" });
    // 送信後に入力欄はクリアされる。
    await waitFor(() => expect(ui().input.value).toBe(""));
  });

  it("error イベントを role=alert で表示する (サーバ message を優先)", async () => {
    mockStreamChat.mockReturnValue(
      gen([
        {
          type: "error",
          status: 429,
          reason: "rate_limited_cookie",
          message: "リクエストが多すぎます。",
        },
      ]),
    );
    render(<StudentChat />);
    await ask("質問");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("リクエストが多すぎます。");
  });

  it("410 gone はサーバ message 無しでも UI 文言にマップする", async () => {
    mockStreamChat.mockReturnValue(gen([{ type: "error", status: 410, reason: "gone" }]));
    render(<StudentChat />);
    await ask("質問");
    expect(await screen.findByRole("alert")).toHaveTextContent(/無効か期限切れ/);
  });

  it("streamChat が throw したらネットワークエラーを表示する", async () => {
    mockStreamChat.mockImplementation(() => {
      throw new Error("network down");
    });
    render(<StudentChat />);
    await ask("質問");
    expect(await screen.findByRole("alert")).toHaveTextContent(/通信に失敗/);
  });

  it("ストリーミング中は送信を無効化し、完了後に再有効化する", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    mockStreamChat.mockReturnValue(
      (async function* () {
        yield { type: "delta", text: "考え中" } satisfies ChatEvent;
        await gate;
        yield { type: "done", sessionId: "s", messageId: "m" } satisfies ChatEvent;
      })(),
    );
    render(<StudentChat />);
    await ask("質問");

    // delta 受信 = ストリーミング中。送信ボタンは無効。
    expect(await screen.findByText("考え中")).toBeInTheDocument();
    expect(ui().send).toBeDisabled();

    release();
    await waitFor(() => expect(ui().send).toBeDisabled()); // 入力空なので依然 disabled
    // 入力すれば再度有効 (ストリーミング終了の確認)。
    fireEvent.change(ui().input, { target: { value: "次の質問" } });
    await waitFor(() => expect(ui().send).not.toBeDisabled());
  });

  it("空ストリーム (delta 無し) では assistant メッセージを足さない", async () => {
    mockStreamChat.mockReturnValue(gen([{ type: "done", sessionId: "s", messageId: "m" }]));
    render(<StudentChat />);
    await ask("質問");
    expect(await screen.findByText("質問")).toBeInTheDocument();
    // assistant ラベルは出ない (本文が無いため)。
    await waitFor(() => expect(ui().input.value).toBe(""));
    expect(screen.queryByText("アシスタント")).not.toBeInTheDocument();
  });
});
