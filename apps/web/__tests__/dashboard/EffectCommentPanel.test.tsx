import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F08 (#44, slice 3): EffectCommentPanel のテスト。`generateEffectComment` Server Action を mock し、
 * 初期状態 (ボタンのみ・コメント無し)、クリックで action を **引数なし** で呼ぶこと、`{ok:true}` で
 * コメント + 月ラベルを表示、`{ok:false}` の pii_leak / error で各安全文言を表示、async 中の
 * pending/disabled を検証する (CommunicationCreateForm.test と同じ mock idiom)。LLM の生成文は
 * mock fixture の文字列だけを断言する (決定論、実 Vertex 文言は断言しない)。
 */

vi.mock("@/lib/dashboard/effect-comment-action", () => ({
  generateEffectComment: vi.fn(),
}));

import { EffectCommentPanel } from "../../app/admin/dashboard/_components/EffectCommentPanel";
import { generateEffectComment } from "../../lib/dashboard/effect-comment-action";

const generateMock = vi.mocked(generateEffectComment);

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

function clickGenerate() {
  fireEvent.click(screen.getByRole("button", { name: "効果コメントを生成" }));
}

describe("EffectCommentPanel (#44 AI 効果コメント UI)", () => {
  it("初期表示は生成ボタンと見出しのみで、コメントは表示しない", () => {
    render(<EffectCommentPanel />);
    expect(screen.getByRole("button", { name: "効果コメントを生成" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "今月の AI 効果コメント" })).toBeInTheDocument();
    // 生成前なので blockquote (コメント本文) は無い。
    expect(document.querySelector("blockquote")).toBeNull();
  });

  it("クリックで action を引数なしで呼び、{ok:true} のコメントと月ラベルを表示する", async () => {
    generateMock.mockResolvedValue({
      ok: true,
      month: "2026-05",
      comment: "今月は先月より反応が増えました。(テスト固定文)",
    });
    render(<EffectCommentPanel />);
    clickGenerate();
    await waitFor(() => expect(generateMock).toHaveBeenCalledTimes(1));
    expect(generateMock).toHaveBeenCalledWith();
    await screen.findByText("今月は先月より反応が増えました。(テスト固定文)");
    expect(screen.getByText("2026-05 の効果コメント")).toBeInTheDocument();
  });

  it("{ok:false, reason:'pii_leak'} で PII 検出の安全文言を表示する", async () => {
    generateMock.mockResolvedValue({ ok: false, reason: "pii_leak" });
    render(<EffectCommentPanel />);
    clickGenerate();
    await screen.findByText("個人情報を検出したため生成を中止しました。");
    expect(document.querySelector("blockquote")).toBeNull();
  });

  it("{ok:false, reason:'error'} で失敗の安全文言を表示する", async () => {
    generateMock.mockResolvedValue({ ok: false, reason: "error" });
    render(<EffectCommentPanel />);
    clickGenerate();
    await screen.findByText("生成に失敗しました。時間をおいて再度お試しください。");
  });

  it("{ok:false, reason:'ai_disabled'} で AI 無効の文言を表示する (#289 kill-switch)", async () => {
    generateMock.mockResolvedValue({ ok: false, reason: "ai_disabled" });
    render(<EffectCommentPanel />);
    clickGenerate();
    await screen.findByText("AI 機能は現在無効です。");
    expect(document.querySelector("blockquote")).toBeNull();
  });

  it("生成中はボタンを disabled + pending 文言にする", async () => {
    // resolve を保留して pending 状態を観測し、その後 resolve して回復を確認する。
    let resolveFn: (v: { ok: false; reason: "error" }) => void = () => {};
    generateMock.mockImplementation(
      () =>
        new Promise<{ ok: false; reason: "error" }>((resolve) => {
          resolveFn = resolve;
        }),
    );
    render(<EffectCommentPanel />);
    clickGenerate();

    // pending: ボタンは「生成中…」で disabled、aria-live に共通の「考え中…」明滅ラベル（横断統一）。
    const pendingBtn = await screen.findByRole("button", { name: "生成中…" });
    expect(pendingBtn).toBeDisabled();
    expect(screen.getByText(/AI が考え中です…/)).toBeInTheDocument();

    // resolve すると非 pending に戻り、ボタン名が元へ。
    resolveFn({ ok: false, reason: "error" });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "効果コメントを生成" })).not.toBeDisabled(),
    );
  });
});
