import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * EditorChat の「音声入力が失敗したときのヒント」表示の固定（PR #876 Reviewer 指摘・非ブロッキング）。
 *
 * `useSpeechToText` を差し替えて `error` を制御し、**実際の失敗のときだけ**マイク付近にヒントが出て、
 * 良性コード / 未発生では出ないことを検証する。STT 実機・SSE・保存系 Server Action には触れない（mock）。
 * 出し分けロジック自体は純関数 `sttErrorHint` の unit test で担保し、ここでは「描画に繋がっている」ことを pin。
 */

// STT フックを差し替えて error を制御する（実機マイク非依存）。fn は安定参照で effect の空振りを避ける。
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

// 保存系 / ファイル取り込み Server Action は import 時に DB・認可を引き込むため mock（描画のみ検証）。
vi.mock("../../lib/editor/notice-assignment-actions", () => ({
  setNoticesAction: vi.fn(),
  setAssignmentsAction: vi.fn(),
}));
vi.mock("../../lib/editor/schedule-actions", () => ({ setScheduleAction: vi.fn() }));
vi.mock("../../lib/editor/assistant-actions", () => ({ assistDraftAllFromFileAction: vi.fn() }));

import { EditorChat } from "../../app/app/editor/_components/EditorChat";

function renderChat() {
  return render(<EditorChat scope="school" targetId="t1" date="2026-06-14" />);
}

beforeEach(() => {
  mockStt.supported = true;
  mockStt.listening = false;
  mockStt.transcript = "";
  mockStt.interim = "";
  mockStt.error = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("EditorChat マイクエラーのヒント", () => {
  it("エラー未発生ではヒントを出さない", () => {
    renderChat();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("良性コード（no-speech）ではヒントを出さない（誤警告回避）", () => {
    mockStt.error = "no-speech";
    renderChat();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("権限拒否（not-allowed）ではマイク付近に権限ヒントを出す", () => {
    mockStt.error = "not-allowed";
    renderChat();
    expect(screen.getByRole("status")).toHaveTextContent("許可");
  });

  it("マイク取得失敗（audio-capture）ではヒントを出す", () => {
    mockStt.error = "audio-capture";
    renderChat();
    expect(screen.getByRole("status")).toHaveTextContent("マイク");
  });
});
