import { describe, expect, it, vi } from "vitest";
import { type ChatEvent, streamChat } from "../../lib/student-qa/chat-client";

/**
 * F06 (#42, #371): SSE チャットクライアント `streamChat` の決定的検証。
 *
 * 実 route / 実ネットワーク不使用 (ADR-012)。`fetchImpl` 注入でモック Response を返し、
 * **名前付き SSE フレームの解析 / チャンク分割耐性 / 2 種の拒否経路 / リクエスト形** を固める。
 */

/** 200 + text/event-stream の Response を、payload を chunkSize 単位に割って返す。 */
function sseResponse(payload: string, opts: { chunkSize?: number } = {}): Response {
  const bytes = new TextEncoder().encode(payload);
  const chunkSize = opts.chunkSize ?? (bytes.length || 1);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) {
        controller.enqueue(bytes.slice(i, i + chunkSize));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}

/** 非 SSE の JSON 拒否 Response (410/400 等)。 */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** generator を配列に集約。 */
async function collect(gen: AsyncGenerator<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe("streamChat", () => {
  it("delta* → done を順に yield する", async () => {
    const payload =
      frame("delta", { text: "こん" }) +
      frame("delta", { text: "にちは" }) +
      frame("done", { sessionId: "s1", messageId: "m1" });
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse(payload));
    const events = await collect(streamChat({ question: "やあ", fetchImpl }));
    expect(events).toEqual([
      { type: "delta", text: "こん" },
      { type: "delta", text: "にちは" },
      { type: "done", sessionId: "s1", messageId: "m1" },
    ]);
  });

  it("受信がフレーム途中で分割されても (chunkSize=1) 正しく再構成する", async () => {
    const payload =
      frame("delta", { text: "ABC" }) + frame("done", { sessionId: "s", messageId: "m" });
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse(payload, { chunkSize: 1 }));
    const events = await collect(streamChat({ question: "q", fetchImpl }));
    expect(events).toEqual([
      { type: "delta", text: "ABC" },
      { type: "done", sessionId: "s", messageId: "m" },
    ]);
  });

  it("マルチバイト UTF-8 (日本語) が byte 境界で分割されても正しく再構成する", async () => {
    // 日本語 1 文字 = UTF-8 3 byte。chunkSize=1 で 1 文字が複数チャンクに割れ、
    // TextDecoder({stream:true}) の繋ぎ込みを実際に pin する (本番の主用途 = 日本語ストリーム)。
    const payload =
      frame("delta", { text: "今日の予定は" }) + frame("done", { sessionId: "s", messageId: "m" });
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse(payload, { chunkSize: 1 }));
    const events = await collect(streamChat({ question: "q", fetchImpl }));
    expect(events).toEqual([
      { type: "delta", text: "今日の予定は" },
      { type: "done", sessionId: "s", messageId: "m" },
    ]);
  });

  it("error フレームを status/reason/message 付きで yield する", async () => {
    const payload = frame("error", {
      status: 429,
      reason: "rate_limited_cookie",
      message: "リクエストが多すぎます。",
    });
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse(payload));
    const events = await collect(streamChat({ question: "q", fetchImpl }));
    expect(events).toEqual([
      {
        type: "error",
        status: 429,
        reason: "rate_limited_cookie",
        message: "リクエストが多すぎます。",
      },
    ]);
  });

  it("410 gone (非 SSE JSON) を error イベントに正規化する", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(410, { error: "gone" }));
    const events = await collect(streamChat({ question: "q", fetchImpl }));
    expect(events).toEqual([{ type: "error", status: 410, reason: "gone" }]);
  });

  it("400 invalid_body (非 SSE JSON) を error イベントに正規化する", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(400, { error: "invalid_body" }));
    const events = await collect(streamChat({ question: "", fetchImpl }));
    expect(events).toEqual([{ type: "error", status: 400, reason: "invalid_body" }]);
  });

  it("非 200 でボディが非 JSON でも request_failed で 1 件 error を返す", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("Bad Gateway", { status: 502 }));
    const events = await collect(streamChat({ question: "q", fetchImpl }));
    expect(events).toEqual([{ type: "error", status: 502, reason: "request_failed" }]);
  });

  it("未知イベント・不正 JSON フレームは無視し、有効フレームのみ通す", async () => {
    const payload =
      "event: heartbeat\ndata: {}\n\n" + // 未知イベント → 無視
      "event: delta\ndata: {not json}\n\n" + // 不正 JSON → 無視
      frame("delta", { text: "ok" }) +
      frame("done", { sessionId: "s", messageId: "m" });
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse(payload));
    const events = await collect(streamChat({ question: "q", fetchImpl }));
    expect(events).toEqual([
      { type: "delta", text: "ok" },
      { type: "done", sessionId: "s", messageId: "m" },
    ]);
  });

  it("末尾フレームが \\n\\n で終端しなくても flush して yield する", async () => {
    // 末尾 done に区切りの \n\n が無いケース。
    const payload = `${frame("delta", { text: "x" })}event: done\ndata: {"sessionId":"s","messageId":"m"}`;
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse(payload));
    const events = await collect(streamChat({ question: "q", fetchImpl }));
    expect(events).toEqual([
      { type: "delta", text: "x" },
      { type: "done", sessionId: "s", messageId: "m" },
    ]);
  });

  it("data 値先頭の 1 スペースを SSE 仕様どおり除去して JSON 解析する", async () => {
    // 手組みで `data: ` の後に空白を 1 つ (route の JSON.stringify 出力相当)。
    const payload = 'event: delta\ndata: {"text":"hi"}\n\n';
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse(payload));
    const events = await collect(streamChat({ question: "q", fetchImpl }));
    expect(events).toEqual([{ type: "delta", text: "hi" }]);
  });

  it("正しい URL / method / headers / body / credentials で POST する", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return Promise.resolve(sseResponse(frame("done", { sessionId: "s", messageId: "m" })));
    });
    await collect(streamChat({ question: "質問", fetchImpl }));
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0] ?? { url: "", init: {} };
    // トークンは URL に載せず cookie で認証する (#371, F05 秘匿維持)。固定エンドポイント。
    expect(url).toBe("/api/student/chat");
    expect(init.method).toBe("POST");
    // 認証 cookie (__student_session) + 端末 cookie (kt_qa_cid) の送受信に必須。
    expect(init.credentials).toBe("same-origin");
    expect(init.headers).toMatchObject({ "content-type": "application/json" });
    expect(JSON.parse(typeof init.body === "string" ? init.body : "{}")).toEqual({
      question: "質問",
    });
  });

  it("abort signal を fetch にそのまま渡す", async () => {
    const ctrl = new AbortController();
    let capturedSignal: AbortSignal | null | undefined;
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      capturedSignal = init?.signal;
      return Promise.resolve(sseResponse(frame("done", { sessionId: "s", messageId: "m" })));
    });
    await collect(streamChat({ question: "q", fetchImpl, signal: ctrl.signal }));
    expect(capturedSignal).toBe(ctrl.signal);
  });
});
