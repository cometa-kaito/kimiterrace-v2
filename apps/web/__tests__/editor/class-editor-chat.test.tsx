import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * {@link ClassEditorChat}（クラスエディタ用ラッパー）の **反映成功 → `?applied=<nonce>` 再ナビゲート**を固定する
 * （2026-07-06 P1: AI 反映後もフォームが古いまま→次の自動保存が反映分を上書き消去する実証バグの是正）。
 *
 * - 反映（全件成功）で `router.replace` が `date`（対象日固定・cutover 跨ぎ対策）と `applied`（再マウント nonce）
 *   を付けて呼ばれ、`scroll: false`（画面位置を保つ）であること
 * - 既存のクエリ（例: `copied`）を保持したまま付けること（URLSearchParams 引き継ぎ）
 * SSE・保存 action は editor-chat-apply.test.tsx と同じ synthetic stub。
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

const replaceMock = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock }),
  usePathname: () => "/app/editor/c1",
  useSearchParams: () => new URLSearchParams("date=2026-06-20&copied=123"),
}));

import { ClassEditorChat } from "../../app/app/editor/[classId]/_components/ClassEditorChat";
import type { AssistantDraft } from "../../lib/editor/assistant-chat-core";

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

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("ClassEditorChat 反映成功 → ?applied= 再ナビゲート", () => {
  it("反映（全件成功）で router.replace が date + applied つき・scroll:false で呼ばれる（既存クエリは保持）", async () => {
    stubSse({ schedules: [], notices: [{ text: "明日は避難訓練です。" }], assignments: [] });
    render(
      <ClassEditorChat
        classId="c1"
        date="2026-06-20"
        pattern="pattern1"
        initialDraft={{ schedules: [], notices: [], assignments: [] }}
        pinnedNotices={[]}
      />,
    );

    const input = screen.getByPlaceholderText(/話す・書く・ファイル/) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "明日避難訓練があります" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // 単一日の反映ボタンは反映先日付つき（2026-07-06 監査 P2-2）。
    fireEvent.click(await screen.findByRole("button", { name: "6/20（土）に反映" }));
    await screen.findByText("盤面に反映しました。");

    expect(replaceMock).toHaveBeenCalledTimes(1);
    const [url, opts] = replaceMock.mock.calls[0] as [string, { scroll: boolean }];
    expect(url.startsWith("/app/editor/c1?")).toBe(true);
    const params = new URLSearchParams(url.split("?")[1]);
    expect(params.get("date")).toBe("2026-06-20");
    expect(params.get("copied")).toBe("123");
    expect(params.get("applied")).toMatch(/^\d+$/);
    expect(opts).toEqual({ scroll: false });
  });
});
