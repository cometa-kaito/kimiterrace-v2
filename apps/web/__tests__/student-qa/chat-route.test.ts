import { beforeEach, describe, expect, it, vi } from "vitest";

// 依存をすべて mock し、route の HTTP/SSE 配線のみを決定論的に検証する (実 DB/Vertex 不使用、ADR-012)。
vi.mock("@kimiterrace/db", () => ({
  resolveMagicLink: vi.fn(),
  // RLS tx を張る代わりにフェイク tx を callback に渡すだけ。
  withTenantContext: vi.fn(async (_db: unknown, _ctx: unknown, fn: (tx: unknown) => unknown) =>
    fn({}),
  ),
}));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("@/lib/magic-link/token", () => ({ hashToken: vi.fn((t: string) => `h:${t}`) }));
vi.mock("@/lib/student-qa/chat-service", () => ({ executeChat: vi.fn() }));
vi.mock("@/lib/student-qa/context-provider", () => ({
  createPublishedContentProvider: vi.fn(() => async () => []),
}));
vi.mock("@kimiterrace/ai", () => ({
  createVertexChatStreamClient: vi.fn(() => ({ stream: vi.fn() })),
}));

import { resolveMagicLink } from "@kimiterrace/db";
import { POST } from "@/app/api/classes/[classToken]/chat/route";
import { executeChat } from "@/lib/student-qa/chat-service";

type Resolved = { id: string; schoolId: string; classId: string };
const RESOLVED: Resolved = { id: "ml-1", schoolId: "s-1", classId: "c-1" };

function makeRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/classes/TOK/chat", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
}
const ctx = { params: Promise.resolve({ classToken: "TOK" }) };

/** executeChat の stream 戻りを模す。textStream は毎回新しい async generator。 */
function streamResult(opts: {
  chunks: string[];
  done?: Promise<{ assistantMessageId: string; sessionId: string }>;
}) {
  return {
    kind: "stream" as const,
    textStream: (async function* () {
      for (const c of opts.chunks) yield c;
    })(),
    done: opts.done ?? Promise.resolve({ assistantMessageId: "amsg-1", sessionId: "sess-1" }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveMagicLink).mockResolvedValue(RESOLVED);
  vi.mocked(executeChat).mockResolvedValue(streamResult({ chunks: ["こん", "にちは"] }));
});

describe("POST /api/classes/[classToken]/chat: 事前検証 (200 を開く前)", () => {
  it("無効/失効トークンは 410 Gone (credential を反射しない)", async () => {
    vi.mocked(resolveMagicLink).mockResolvedValue(null);
    const res = await POST(makeRequest({ question: "やあ" }), ctx);
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: "gone" });
    expect(executeChat).not.toHaveBeenCalled();
  });

  it("不正 JSON は 400 invalid_json", async () => {
    const res = await POST(makeRequest("{not json"), ctx);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_json" });
  });

  it("question が文字列でなければ 400 invalid_body", async () => {
    const res = await POST(makeRequest({ question: 123 }), ctx);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_body" });
  });
});

describe("POST: 正常系 SSE", () => {
  it("200 text/event-stream で delta→done を送出し、tx 内で executeChat を呼ぶ", async () => {
    const res = await POST(makeRequest({ question: "体育祭は？" }), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-store");

    const text = await res.text();
    expect(text).toContain('event: delta\ndata: {"text":"こん"}');
    expect(text).toContain('event: delta\ndata: {"text":"にちは"}');
    expect(text).toContain('event: done\ndata: {"sessionId":"sess-1","messageId":"amsg-1"}');

    // 解決済 magic link → executeChat の認証コンテキストへ正しく配線。
    const arg = vi.mocked(executeChat).mock.calls[0]?.[0];
    expect(arg).toMatchObject({
      schoolId: "s-1",
      classId: "c-1",
      magicLinkId: "ml-1",
      rawQuestion: "体育祭は？",
      piiEntries: [],
    });
    expect(typeof arg?.cookieId).toBe("string");
  });

  it("cookie 無しなら kt_qa_cid を採番して HttpOnly Set-Cookie する", async () => {
    const res = await POST(makeRequest({ question: "やあ" }), ctx);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("kt_qa_cid=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Secure");
  });

  it("cookie 有りなら再採番せず、その値を rate-limit 第二キーに使う", async () => {
    const res = await POST(
      makeRequest({ question: "やあ" }, { cookie: "kt_qa_cid=cid-existing" }),
      ctx,
    );
    expect(res.headers.get("set-cookie")).toBeNull();
    await res.text();
    expect(vi.mocked(executeChat).mock.calls[0]?.[0].cookieId).toBe("cid-existing");
  });
});

describe("POST: 拒否・エラーは 200 + SSE error フレーム (rate-limit 二重消費を避ける)", () => {
  it("executeChat の rejected (429) は SSE error フレームで通知する", async () => {
    vi.mocked(executeChat).mockResolvedValue({
      kind: "rejected",
      status: 429,
      reason: "rate_limited_magic_link",
      message: "リクエストが多すぎます。",
    });
    const res = await POST(makeRequest({ question: "やあ" }), ctx);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("event: error");
    expect(text).toContain('"status":429');
    expect(text).toContain('"reason":"rate_limited_magic_link"');
  });

  it("ストリーム/永続化中の例外 (done reject) は stream_failed の error フレームにする", async () => {
    vi.mocked(executeChat).mockResolvedValue(
      streamResult({ chunks: ["x"], done: Promise.reject(new Error("boom")) }),
    );
    const res = await POST(makeRequest({ question: "やあ" }), ctx);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('event: delta\ndata: {"text":"x"}');
    expect(text).toContain("event: error");
    expect(text).toContain('"reason":"stream_failed"');
  });
});
