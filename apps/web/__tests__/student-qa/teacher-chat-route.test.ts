import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 依存をすべて mock し、route + sse-handler の 認証/HTTP/SSE 配線のみを決定論的に検証する
// (実 DB/Vertex/IdP 不使用、ADR-012)。認証は getCurrentUser を mock する。
vi.mock("@kimiterrace/db", () => ({
  withTenantContext: vi.fn(async (_db: unknown, _ctx: unknown, fn: (tx: unknown) => unknown) =>
    fn({}),
  ),
}));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: vi.fn() }));
vi.mock("@/lib/student-qa/chat-service", () => ({ executeChat: vi.fn() }));
vi.mock("@/lib/student-qa/context-provider", () => ({
  createRagContentProvider: vi.fn(() => async () => []),
}));
vi.mock("@kimiterrace/ai", () => ({
  createVertexChatStreamClient: vi.fn(() => ({ stream: vi.fn() })),
  createVertexEmbeddingClient: vi.fn(() => ({ embed: vi.fn(async () => []) })),
  normalizeLocale: vi.fn(() => "ja"),
}));

import { POST } from "@/app/api/teacher/chat/route";
import { getCurrentUser } from "@/lib/auth/session";
import { executeChat } from "@/lib/student-qa/chat-service";

type AuthUser = { uid: string; role: string; schoolId: string | null };
const TEACHER: AuthUser = { uid: "u-1", role: "teacher", schoolId: "s-1" };

function makeRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/teacher/chat", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
}

function streamResult(chunks: string[]) {
  return {
    kind: "stream" as const,
    textStream: (async function* () {
      for (const c of chunks) yield c;
    })(),
    done: Promise.resolve({ assistantMessageId: "amsg-t1", sessionId: "sess-t1" }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // biome-ignore lint/suspicious/noExplicitAny: テスト用に AuthUser 形を流し込む (実型は session.ts)。
  vi.mocked(getCurrentUser).mockResolvedValue(TEACHER as any);
  vi.mocked(executeChat).mockResolvedValue(streamResult(["はい", "、保護者会は6/20です"]));
});
afterEach(() => {
  vi.unstubAllEnvs(); // #289: AI_ENABLED の stub を後続テストへ漏らさない (setup の "true" へ復元)。
});

describe("POST /api/teacher/chat: 認証 + role gate (200 を開く前)", () => {
  it("AI 無効 (AI_ENABLED!=true) は 503 ai_disabled で塞ぎ、executeChat を呼ばない (#289 kill-switch)", async () => {
    // 認可済み教員でも、共通 seam (respondWithChatStream) の gate が実 Vertex 前に短絡する。
    vi.stubEnv("AI_ENABLED", "false");
    const res = await POST(makeRequest({ question: "保護者会は？" }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "ai_disabled" });
    expect(executeChat).not.toHaveBeenCalled();
  });

  it("未認証 (getCurrentUser=null) は 401 unauthenticated、executeChat を呼ばない", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null);
    const res = await POST(makeRequest({ question: "やあ" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthenticated" });
    expect(executeChat).not.toHaveBeenCalled();
  });

  it("role 不足 (system_admin) は 403 forbidden (PUBLISHER_ROLES 外)", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: テスト用ロール差し込み。
    vi.mocked(getCurrentUser).mockResolvedValue({ ...TEACHER, role: "system_admin" } as any);
    const res = await POST(makeRequest({ question: "やあ" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
    expect(executeChat).not.toHaveBeenCalled();
  });

  it("school_admin は許可 (PUBLISHER_ROLES)", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: テスト用ロール差し込み。
    vi.mocked(getCurrentUser).mockResolvedValue({ ...TEACHER, role: "school_admin" } as any);
    const res = await POST(makeRequest({ question: "やあ" }));
    expect(res.status).toBe(200);
    await res.text();
    expect(executeChat).toHaveBeenCalledTimes(1);
  });

  it("school_id が null の壊れたアカウントは 403 forbidden (deny-by-default)", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: テスト用に schoolId=null を差し込む。
    vi.mocked(getCurrentUser).mockResolvedValue({ ...TEACHER, schoolId: null } as any);
    const res = await POST(makeRequest({ question: "やあ" }));
    expect(res.status).toBe(403);
    expect(executeChat).not.toHaveBeenCalled();
  });

  it("不正ボディは 400 (respondWithChatStream に委譲)", async () => {
    const res = await POST(makeRequest({ question: 123 }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_body" });
  });
});

describe("POST /api/teacher/chat: 正常系 SSE + identity 配線", () => {
  it("200 SSE で delta→done、executeChat に teacher identity + 認証由来の userId/schoolId を渡す", async () => {
    const res = await POST(makeRequest({ question: "保護者会は？" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    // 教員経路は端末 cookie を使わない (Set-Cookie 無し)。
    expect(res.headers.get("set-cookie")).toBeNull();

    const text = await res.text();
    expect(text).toContain('event: delta\ndata: {"text":"はい"}');
    expect(text).toContain('event: done\ndata: {"sessionId":"sess-t1","messageId":"amsg-t1"}');

    // identity.userId / schoolId は **認証済みセッションからのみ** 導出 (confused-deputy 防止)。
    const arg = vi.mocked(executeChat).mock.calls[0]?.[0];
    expect(arg).toMatchObject({
      schoolId: "s-1",
      rawQuestion: "保護者会は？",
      piiEntries: [],
      identity: { kind: "teacher", userId: "u-1" },
    });
  });

  it("executeChat の rejected (429) は SSE error フレームで通知する", async () => {
    vi.mocked(executeChat).mockResolvedValue({
      kind: "rejected",
      status: 429,
      reason: "rate_limited_user",
      message: "リクエストが多すぎます。",
    });
    const res = await POST(makeRequest({ question: "やあ" }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("event: error");
    expect(text).toContain('"reason":"rate_limited_user"');
  });
});
