import { describe, expect, it, vi } from "vitest";
import {
  NOTICE_DRAFT_ENDPOINT,
  type NoticeDraftEvent,
  streamNoticeDraft,
} from "../../lib/editor/notice-draft-client";

/**
 * 段C+（#243 ②UI-UX, ADR-033）: streamNoticeDraft（SSE クライアント）の解析・正規化検証。
 * fetch を注入し DOM 非依存で決定論検証（chat-client.test と同方針, ADR-012）: notice/notice_redacted/done の
 * 逐次 yield、error フレーム（pii_warning + suspectedSurfaces）、request-level 拒否（非 event-stream JSON）、
 * チャンク境界をまたぐフレームのバッファ再構成、リクエスト URL/body、network 例外。
 */

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** 1 チャンクの SSE Response（content-type は event-stream）。 */
function sseResponse(frames: string[]): Response {
  return new Response(frames.join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** 任意のチャンク列で body を流す SSE Response（フレーム分割の再構成テスト用）。 */
function chunkedResponse(chunks: string[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function collect(gen: AsyncGenerator<NoticeDraftEvent>): Promise<NoticeDraftEvent[]> {
  const out: NoticeDraftEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

const CLASS_ID = "11111111-1111-4111-8111-111111111111";

describe("streamNoticeDraft", () => {
  it("notice* → done を逐次 yield する", async () => {
    const fetchImpl = vi.fn(async () =>
      sseResponse([
        frame("notice", { index: 0, text: "明日は短縮授業です。", isHighlight: false }),
        frame("notice", { index: 1, text: "返却は金曜まで。", isHighlight: true }),
        frame("done", { count: 2 }),
      ]),
    );
    const evs = await collect(
      streamNoticeDraft({ scope: "class", targetId: CLASS_ID, text: "メモ", fetchImpl }),
    );
    expect(evs).toEqual([
      { type: "notice", index: 0, text: "明日は短縮授業です。", isHighlight: false },
      { type: "notice", index: 1, text: "返却は金曜まで。", isHighlight: true },
      { type: "done", count: 2 },
    ]);
  });

  it("notice_redacted を混在で yield する", async () => {
    const fetchImpl = vi.fn(async () =>
      sseResponse([
        frame("notice", { index: 0, text: "連絡1", isHighlight: false }),
        frame("notice_redacted", { index: 1 }),
        frame("done", { count: 1 }),
      ]),
    );
    const evs = await collect(
      streamNoticeDraft({ scope: "class", targetId: CLASS_ID, text: "メモ", fetchImpl }),
    );
    expect(evs.map((e) => e.type)).toEqual(["notice", "notice_redacted", "done"]);
  });

  it("error フレーム（pii_warning）は suspectedSurfaces を含めて yield する", async () => {
    const fetchImpl = vi.fn(async () =>
      sseResponse([
        frame("error", { status: 409, reason: "pii_warning", suspectedSurfaces: ["田中さん"] }),
      ]),
    );
    const evs = await collect(
      streamNoticeDraft({ scope: "class", targetId: CLASS_ID, text: "田中さん欠席", fetchImpl }),
    );
    expect(evs).toEqual([
      {
        type: "error",
        status: 409,
        reason: "pii_warning",
        suspectedSurfaces: ["田中さん"],
        message: undefined,
      },
    ]);
  });

  it("request-level 拒否（非 event-stream JSON）を error に正規化する", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "ai_disabled" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
    );
    const evs = await collect(
      streamNoticeDraft({ scope: "class", targetId: CLASS_ID, text: "メモ", fetchImpl }),
    );
    expect(evs).toEqual([{ type: "error", status: 503, reason: "ai_disabled" }]);
  });

  it("チャンク境界をまたぐフレームをバッファで再構成する", async () => {
    const full =
      frame("notice", { index: 0, text: "連絡A", isHighlight: false }) +
      frame("done", { count: 1 });
    // 任意の位置で 3 分割（フレーム途中・区切り途中をまたぐ）。
    const a = full.slice(0, 10);
    const b = full.slice(10, 40);
    const c = full.slice(40);
    const fetchImpl = vi.fn(async () => chunkedResponse([a, b, c]));
    const evs = await collect(
      streamNoticeDraft({ scope: "class", targetId: CLASS_ID, text: "メモ", fetchImpl }),
    );
    expect(evs).toEqual([
      { type: "notice", index: 0, text: "連絡A", isHighlight: false },
      { type: "done", count: 1 },
    ]);
  });

  it("scope/targetId をクエリに、text/acknowledgePii をボディに載せて POST する", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => sseResponse([frame("done", { count: 0 })]));
    await collect(
      streamNoticeDraft({
        scope: "class",
        targetId: CLASS_ID,
        text: "メモ",
        acknowledgePii: true,
        fetchImpl,
      }),
    );
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(`${NOTICE_DRAFT_ENDPOINT}?scope=class&targetId=${CLASS_ID}`);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ text: "メモ", acknowledgePii: true });
    expect(init?.credentials).toBe("same-origin");
  });

  it("tone を指定するとボディに載せる", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => sseResponse([frame("done", { count: 0 })]));
    await collect(
      streamNoticeDraft({
        scope: "class",
        targetId: CLASS_ID,
        text: "メモ",
        tone: "short",
        fetchImpl,
      }),
    );
    const [, init] = fetchImpl.mock.calls[0] ?? [];
    expect(JSON.parse(init?.body as string)).toEqual({
      text: "メモ",
      acknowledgePii: false,
      tone: "short",
    });
  });

  it("school scope は targetId をクエリに載せない", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => sseResponse([frame("done", { count: 0 })]));
    await collect(streamNoticeDraft({ scope: "school", targetId: null, text: "メモ", fetchImpl }));
    const [url] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(`${NOTICE_DRAFT_ENDPOINT}?scope=school`);
  });

  it("ネットワーク例外は error(network) に倒す", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("boom");
    });
    const evs = await collect(
      streamNoticeDraft({ scope: "class", targetId: CLASS_ID, text: "メモ", fetchImpl }),
    );
    expect(evs).toEqual([{ type: "error", status: 0, reason: "network" }]);
  });
});
