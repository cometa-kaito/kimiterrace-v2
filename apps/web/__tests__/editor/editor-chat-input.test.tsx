import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * EditorChat の入力欄操作性改善（改善1）を固定する。**UI/操作のみ**で、会話・保存・SSE のロジックには触れない。
 *
 * - 複数行入力できる `<textarea>` で、内容に応じて高さが自動で伸び、上限（INPUT_MAX_HEIGHT=140px）で頭打ちに
 *   なって内部スクロールに切り替わる（LINE 風）。
 * - 送信は Enter（Shift+Enter は改行＝送信しない）。⌘/Ctrl+Enter も従来どおり送信。送信後に入力をクリアし
 *   高さをリセットする。
 * - 日本語 IME 変換確定の Enter（composition 中 / nativeEvent.isComposing / keyCode 229）では誤送信しない。
 *
 * jsdom は scrollHeight を 0 で返すため、autoGrow の上限ロジックは scrollHeight を stub して検証する。
 * 送信ハンドラ（stream→fetch）は実ネットワークに出さないよう fetch を stub し、「送信されたか」は入力の
 * クリアと fetch 呼び出しで観測する（保存系 Server Action は import 時に DB/認可を引くため mock）。
 */

const mockStt = vi.hoisted(() => ({
  supported: true,
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

function renderChat() {
  return render(<EditorChat scope="school" targetId="t1" date="2026-06-16" />);
}

function getInput(): HTMLTextAreaElement {
  return screen.getByPlaceholderText(/Enter で送信/) as HTMLTextAreaElement;
}

// stream() が即解決するよう、本文のない ok レスポンスで fetch を stub（SSE は流さない）。
function stubFetchOk() {
  const fetchMock = vi.fn(async () => ({ ok: true, body: null }) as unknown as Response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  mockStt.supported = true;
  mockStt.listening = false;
  mockStt.transcript = "";
  mockStt.error = null;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("EditorChat 入力欄（改善1: 自動伸長 + 上限スクロール）", () => {
  it("入力欄は textarea で、内容が増えると高さが伸び、上限 140px で頭打ちになる", () => {
    renderChat();
    const input = getInput();
    expect(input.tagName).toBe("TEXTAREA");

    // 短い内容: scrollHeight=60 を stub → height=60px。
    Object.defineProperty(input, "scrollHeight", { configurable: true, value: 60 });
    fireEvent.change(input, { target: { value: "1行" } });
    expect(input.style.height).toBe("60px");

    // 長い内容: scrollHeight=400 を stub → 上限 140px で頭打ち（超過分は overflow スクロール）。
    Object.defineProperty(input, "scrollHeight", { configurable: true, value: 400 });
    fireEvent.change(input, { target: { value: "とても長い\n複数行\nの\n入力\n内容\nです" } });
    expect(input.style.height).toBe("140px");
  });
});

describe("EditorChat 送信キー操作（改善1: Enter 送信 / Shift+Enter 改行 / IME ガード）", () => {
  it("Enter で送信し、送信後は入力をクリアする", async () => {
    const fetchMock = stubFetchOk();
    renderChat();
    const input = getInput();
    fireEvent.change(input, { target: { value: "今日の連絡です" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(input.value).toBe("");
  });

  it("Shift+Enter は送信しない（改行を許可）", () => {
    const fetchMock = stubFetchOk();
    renderChat();
    const input = getInput();
    fireEvent.change(input, { target: { value: "途中の文" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(fetchMock).not.toHaveBeenCalled();
    // 入力は保持（送信されていない）。
    expect(input.value).toBe("途中の文");
  });

  it("IME 変換確定の Enter（isComposing）では送信しない", () => {
    const fetchMock = stubFetchOk();
    renderChat();
    const input = getInput();
    fireEvent.change(input, { target: { value: "へんかんちゅう" } });
    // nativeEvent.isComposing=true の Enter は変換確定なので送信しない。
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(input.value).toBe("へんかんちゅう");
  });

  it("⌘/Ctrl+Enter でも従来どおり送信する", async () => {
    const fetchMock = stubFetchOk();
    renderChat();
    const input = getInput();
    fireEvent.change(input, { target: { value: "送信内容" } });
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(input.value).toBe("");
  });
});
