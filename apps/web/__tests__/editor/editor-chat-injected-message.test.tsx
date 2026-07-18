import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * P1 写真取込（D5）: EditorChat の**注入ターン自動送信**を固定する。注入メッセージが通常の user ターン
 * として送信サーフェス（fetch body の messages）に乗ること・送信着手時に consume が 1 回だけ呼ばれる
 * ことを検証する（editor-chat-input.test.tsx と同じ fetch stub 手法・SSE は流さない）。
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
  setNoticesAction: vi.fn(),
  setAssignmentsAction: vi.fn(),
}));
vi.mock("../../lib/editor/schedule-actions", () => ({ setScheduleAction: vi.fn() }));
vi.mock("../../lib/editor/assistant-actions", () => ({ assistDraftAllFromFileAction: vi.fn() }));

import { EditorChat } from "../../app/app/editor/_components/EditorChat";

function stubFetchOk() {
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      ({ ok: true, body: null }) as unknown as Response,
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("EditorChat 注入ターン（P1 写真取込）", () => {
  it("injectedMessage を user ターンとして自動送信し、consume を呼ぶ", async () => {
    const fetchMock = stubFetchOk();
    const consume = vi.fn();
    render(
      <EditorChat
        scope="class"
        targetId="c1"
        date="2026-07-06"
        injectedMessage={"【プリント本文】\n7月7日の時間割変更"}
        onInjectedMessageConsumed={consume}
      />,
    );
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}")) as {
      messages?: { role: string; content: string }[];
    };
    expect(body.messages?.at(-1)?.role).toBe("user");
    expect(body.messages?.at(-1)?.content).toContain("7月7日の時間割変更");
    expect(consume).toHaveBeenCalledTimes(1);
    // 会話ログにも user ターンとして現れる（通常送信と同一経路）。
    expect(screen.getByText(/7月7日の時間割変更/)).toBeTruthy();
  });

  it("injectedMessage が無ければ何も送らない（従来挙動）", async () => {
    const fetchMock = stubFetchOk();
    render(<EditorChat scope="class" targetId="c1" date="2026-07-06" />);
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
