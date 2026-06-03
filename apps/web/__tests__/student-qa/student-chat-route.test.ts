import { beforeEach, describe, expect, it, vi } from "vitest";

// 依存をすべて mock し、route + sse-handler の HTTP/SSE 配線のみを決定論的に検証する
// (実 DB/Vertex 不使用、ADR-012)。認証は cookie 再解決 (resolveStudentSession) を mock する。
vi.mock("@kimiterrace/db", () => ({
  // RLS tx を張る代わりにフェイク tx を callback に渡すだけ。
  withTenantContext: vi.fn(async (_db: unknown, _ctx: unknown, fn: (tx: unknown) => unknown) =>
    fn({}),
  ),
}));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("@/lib/magic-link/student-session", () => ({ resolveStudentSession: vi.fn() }));
vi.mock("@/lib/student-qa/chat-service", () => ({ executeChat: vi.fn() }));
vi.mock("@/lib/student-qa/context-provider", () => ({
  createRagContentProvider: vi.fn(() => async () => []),
}));
vi.mock("@kimiterrace/ai", () => ({
  createVertexChatStreamClient: vi.fn(() => ({ stream: vi.fn() })),
  createVertexEmbeddingClient: vi.fn(() => ({ embed: vi.fn(async () => []) })),
  normalizeLocale: vi.fn(() => "ja"),
}));

import { POST } from "@/app/api/student/chat/route";
import { resolveStudentSession } from "@/lib/magic-link/student-session";
import { executeChat } from "@/lib/student-qa/chat-service";

type Resolved = { id: string; schoolId: string; classId: string };
const RESOLVED: Resolved = { id: "ml-1", schoolId: "s-1", classId: "c-1" };

function makeRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/student/chat", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
}

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
  vi.mocked(resolveStudentSession).mockResolvedValue(RESOLVED);
  vi.mocked(executeChat).mockResolvedValue(streamResult({ chunks: ["こん", "にちは"] }));
});

describe("POST /api/student/chat: 認証 (cookie 再解決) + 事前検証 (200 を開く前)", () => {
  it("cookie 無効/失効/未設定 (resolveStudentSession=null) は 410 Gone (credential を反射しない)", async () => {
    vi.mocked(resolveStudentSession).mockResolvedValue(null);
    const res = await POST(makeRequest({ question: "やあ" }));
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: "gone" });
    expect(executeChat).not.toHaveBeenCalled();
  });

  it("トークンは URL に載らない (cookie 認証経路、ルール5)", async () => {
    // 解決は cookie 由来 (resolveStudentSession) で、リクエスト URL に生トークンは含まれない。
    const res = await POST(makeRequest({ question: "やあ" }));
    expect(res.status).toBe(200);
    expect(vi.mocked(resolveStudentSession)).toHaveBeenCalledTimes(1);
    await res.text();
  });

  it("不正 JSON は 400 invalid_json", async () => {
    const res = await POST(makeRequest("{not json"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_json" });
  });

  it("question が文字列でなければ 400 invalid_body", async () => {
    const res = await POST(makeRequest({ question: 123 }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_body" });
  });
});

describe("POST: 正常系 SSE", () => {
  it("200 text/event-stream で delta→done を送出し、tx 内で executeChat を呼ぶ", async () => {
    const res = await POST(makeRequest({ question: "体育祭は？" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-store");

    const text = await res.text();
    expect(text).toContain('event: delta\ndata: {"text":"こん"}');
    expect(text).toContain('event: delta\ndata: {"text":"にちは"}');
    expect(text).toContain('event: done\ndata: {"sessionId":"sess-1","messageId":"amsg-1"}');

    // 解決済 magic link (cookie 由来) → executeChat の認証コンテキストへ正しく配線。
    const arg = vi.mocked(executeChat).mock.calls[0]?.[0];
    expect(arg).toMatchObject({
      schoolId: "s-1",
      rawQuestion: "体育祭は？",
      piiEntries: [],
      identity: { kind: "student", classId: "c-1", magicLinkId: "ml-1" },
    });
    expect(arg?.identity.kind === "student" && typeof arg.identity.cookieId).toBe("string");
  });

  it("kt_qa_cid cookie 無しなら採番して HttpOnly Set-Cookie する", async () => {
    const res = await POST(makeRequest({ question: "やあ" }));
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("kt_qa_cid=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Secure");
  });

  it("kt_qa_cid cookie 有りなら再採番せず、その値を rate-limit 第二キーに使う", async () => {
    const res = await POST(makeRequest({ question: "やあ" }, { cookie: "kt_qa_cid=cid-existing" }));
    expect(res.headers.get("set-cookie")).toBeNull();
    await res.text();
    const identity = vi.mocked(executeChat).mock.calls[0]?.[0].identity;
    expect(identity?.kind === "student" && identity.cookieId).toBe("cid-existing");
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
    const res = await POST(makeRequest({ question: "やあ" }));
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
    const res = await POST(makeRequest({ question: "やあ" }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('event: delta\ndata: {"text":"x"}');
    expect(text).toContain("event: error");
    expect(text).toContain('"reason":"stream_failed"');
  });
});
