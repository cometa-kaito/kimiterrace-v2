import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F02 (#38): TeacherInputComposer のテスト。useSpeechToText と fetch を mock。
 * チャット送信が確定テキストのみを `POST /api/teacher-inputs` に渡すこと (音声は送らない設計)、
 * 入力種別 (chat/voice) の判定、成功 / 失敗 / 空送信ガード、未対応ブラウザ表示を検証する。
 */

const { hookState } = vi.hoisted(() => ({
  hookState: {
    supported: true,
    listening: false,
    transcript: "",
    interim: "",
    error: null as string | null,
    start: vi.fn(),
    stop: vi.fn(),
    reset: vi.fn(),
  },
}));

vi.mock("@/lib/teacher-input/use-speech-to-text", () => ({
  useSpeechToText: () => hookState,
}));

import { TeacherInputComposer } from "../../app/app/teacher-input/_components/TeacherInputComposer";

function mockFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  const fn = vi.fn(impl);
  vi.stubGlobal("fetch", fn);
  return fn;
}

function okJson(body: unknown): Promise<Response> {
  return Promise.resolve({ ok: true, status: 201, json: async () => body } as Response);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  hookState.supported = true;
  hookState.listening = false;
  hookState.transcript = "";
  hookState.interim = "";
  hookState.error = null;
});

describe("TeacherInputComposer", () => {
  it("チャット入力を確定テキストのみで POST し (inputType=chat)、成功表示と入力クリア", async () => {
    const fetchFn = mockFetch(() => okJson({ id: "ti-1" }));
    render(<TeacherInputComposer />);
    const textarea = screen.getByLabelText("連絡内容");
    fireEvent.change(textarea, { target: { value: "  明日10時から体育館で説明会  " } });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));

    await waitFor(() => expect(fetchFn).toHaveBeenCalledOnce());
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe("/api/teacher-inputs");
    expect(JSON.parse(String(init?.body))).toEqual({
      inputType: "chat",
      transcript: "明日10時から体育館で説明会", // trim 済、音声バイナリは一切含まない
      status: "ready",
    });
    expect(await screen.findByRole("status")).toHaveTextContent("入力を受け付けました");
    expect(screen.getByLabelText("連絡内容")).toHaveValue("");
  });

  it("音声で取り込んだテキストは inputType=voice で送信される", async () => {
    hookState.transcript = "音声からのテキスト"; // マウント時の effect で textarea に取り込まれる
    const fetchFn = mockFetch(() => okJson({ id: "ti-2" }));
    render(<TeacherInputComposer />);
    expect(screen.getByLabelText("連絡内容")).toHaveValue("音声からのテキスト");
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledOnce());
    const body = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body));
    expect(body.inputType).toBe("voice");
    expect(body.transcript).toBe("音声からのテキスト");
  });

  it("空 (空白のみ) は送信ボタンが無効で fetch しない", () => {
    const fetchFn = mockFetch(() => okJson({ id: "x" }));
    render(<TeacherInputComposer />);
    fireEvent.change(screen.getByLabelText("連絡内容"), { target: { value: "   " } });
    const submit = screen.getByRole("button", { name: "送信" });
    expect(submit).toBeDisabled();
    fireEvent.click(submit);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("サーバーエラー (res.ok=false) は error を表示し、入力は保持する", async () => {
    mockFetch(() => Promise.resolve({ ok: false, status: 500 } as Response));
    render(<TeacherInputComposer />);
    fireEvent.change(screen.getByLabelText("連絡内容"), { target: { value: "テスト連絡" } });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("送信に失敗しました (500)");
    expect(screen.getByLabelText("連絡内容")).toHaveValue("テスト連絡");
  });

  it("未対応ブラウザでは音声ボタンを出さず、チャットは使える旨を表示", () => {
    hookState.supported = false;
    mockFetch(() => okJson({ id: "x" }));
    render(<TeacherInputComposer />);
    expect(screen.queryByRole("button", { name: /音声入力/ })).not.toBeInTheDocument();
    expect(screen.getByText(/このブラウザは音声入力に未対応/)).toBeInTheDocument();
  });

  it("対応ブラウザでは音声ボタンを表示し、クリックで start を呼ぶ", () => {
    mockFetch(() => okJson({ id: "x" }));
    render(<TeacherInputComposer />);
    fireEvent.click(screen.getByRole("button", { name: "🎤 音声入力" }));
    expect(hookState.start).toHaveBeenCalledOnce();
  });

  it("送信中は共通の「考え中…」明滅ラベル（横断統一 .kt-thinking）を出す", async () => {
    // 解決しない fetch で submitting 状態を保持する。
    let resolveFetch: (r: Response) => void = () => {};
    mockFetch(
      () =>
        new Promise<Response>((r) => {
          resolveFetch = r;
        }),
    );
    render(<TeacherInputComposer />);
    fireEvent.change(screen.getByLabelText("連絡内容"), {
      target: { value: "明日10時から説明会" },
    });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));

    expect(await screen.findByText("● 送信中…")).toBeInTheDocument();

    // クリーンアップ: 解決して done に遷移、明滅ラベルが消えるまで待つ。
    resolveFetch({ ok: true, status: 201, json: async () => ({ id: "x" }) } as Response);
    await waitFor(() => expect(screen.queryByText("● 送信中…")).not.toBeInTheDocument());
  });
});
