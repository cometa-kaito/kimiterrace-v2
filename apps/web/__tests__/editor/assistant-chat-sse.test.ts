import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantTurnPartial } from "@kimiterrace/ai";

/**
 * 会話型 AI アシスタント SSE（respondWithAssistantChat）の配線・セキュリティ分岐検証。
 * DB/Vertex/PII helper はモック、stream client / rate limiter は deps 注入（notice-draft-sse.test と同方針）。
 * kill-switch・ボディ検証・soft-gate・レート制限・mask fail-closed・正常ストリーム（meta/message/draft/done）・
 * 監査書込・no_result・stream_failed を固める。
 */

const h = vi.hoisted(() => ({
  isAiEnabled: vi.fn(),
  findSuspectedPersonalNames: vi.fn(),
  findUnmaskedPii: vi.fn(),
  maskPII: vi.fn(),
  unmaskPII: vi.fn(),
  unmaskDeep: vi.fn(),
  insertValues: vi.fn(),
}));

vi.mock("@/lib/ai/ai-enabled", () => ({ isAiEnabled: h.isAiEnabled }));
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("@kimiterrace/db", () => ({
  auditLog: {},
  withTenantContext: (_db: unknown, _ctx: unknown, cb: (tx: unknown) => unknown) =>
    cb({ insert: () => ({ values: h.insertValues }) }),
}));
vi.mock("@kimiterrace/ai", () => ({
  findSuspectedPersonalNames: h.findSuspectedPersonalNames,
  findUnmaskedPii: h.findUnmaskedPii,
  maskPII: h.maskPII,
  unmaskPII: h.unmaskPII,
  unmaskDeep: h.unmaskDeep,
  createPerSchoolRateLimiter: () => ({ tryAcquire: () => true }),
  createVertexAssistantChatClient: () => ({ stream: () => ({}) }),
}));

import { respondWithAssistantChat } from "../../lib/editor/assistant-chat-sse";

const CLASS_ID = "11111111-1111-4111-8111-111111111111";
const ARGS = {
  target: { scope: "class", classId: CLASS_ID },
  actor: { userId: "u1", schoolId: "s1" },
  tenantContext: { userId: "u1", schoolId: "s1", role: "teacher" },
  allowedSections: ["schedules", "notices", "assignments"],
  pattern: "pattern1",
  manualSectionLabels: [],
} as const;

function req(body: unknown, rawBody?: string): Request {
  return new Request(`https://x/api/editor/assistant/chat?scope=class&targetId=${CLASS_ID}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: rawBody ?? JSON.stringify(body),
  });
}

/** 注入する stream client。partials を順に yield（"THROW" は途中失敗を模す）。 */
function fakeStreamClient(partials: (AssistantTurnPartial | "THROW")[]) {
  const stream = vi.fn((_req: { system: string; user: string }) => ({
    partialStream: (async function* () {
      for (const p of partials) {
        if (p === "THROW") throw new Error("model down");
        yield p;
      }
    })(),
    done: Promise.resolve({ modelVersion: "fake", tokenCount: 3 }),
  }));
  return { stream };
}

function deps(partials: (AssistantTurnPartial | "THROW")[], opts: { acquire?: boolean } = {}) {
  return {
    streamClient: fakeStreamClient(partials),
    rateLimiter: { tryAcquire: vi.fn().mockResolvedValue(opts.acquire ?? true) },
    nowMs: 1000,
  };
}

/**
 * 無応答 stream client: partial を一切 yield せず done も解決しない（本番の「考えています」ハングを模す）。
 * handler が張る AbortSignal が abort されると partialStream が reject し、handler が stream_failed に畳む。
 */
function hangingStreamClient() {
  const stream = vi.fn((streamReq: { system: string; user: string; signal?: AbortSignal }) => ({
    partialStream: (async function* () {
      await new Promise<never>((_resolve, reject) => {
        streamReq.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    })(),
    // usage は永久に未解決（handler は partialStream の中断で先に catch へ抜ける）。
    done: new Promise<{ modelVersion: string; tokenCount: number }>(() => {}),
  }));
  return { stream };
}

/** SSE Response を {event,data} フレーム列に解析する。 */
async function frames(res: Response): Promise<Array<{ event: string; data: unknown }>> {
  const text = await res.text();
  const out: Array<{ event: string; data: unknown }> = [];
  for (const block of text.split("\n\n")) {
    const lines = block.split("\n");
    const ev = lines.find((l) => l.startsWith("event: "))?.slice(7);
    const dt = lines.find((l) => l.startsWith("data: "))?.slice(6);
    if (ev && dt) out.push({ event: ev, data: JSON.parse(dt) });
  }
  return out;
}

const USER_TURN = [{ role: "user", content: "明日の1限を数学に" }];

beforeEach(() => {
  h.isAiEnabled.mockReset().mockReturnValue(true);
  h.findSuspectedPersonalNames.mockReset().mockReturnValue([]);
  h.findUnmaskedPii.mockReset().mockReturnValue([]);
  h.maskPII.mockReset().mockImplementation((t: string) => ({ masked: t, dictionary: {} }));
  h.unmaskPII.mockReset().mockImplementation((t: string) => t);
  h.unmaskDeep.mockReset().mockImplementation((v: unknown) => v);
  h.insertValues.mockReset().mockResolvedValue(undefined);
});

describe("respondWithAssistantChat", () => {
  it("AI 無効は 503 JSON（SSE を開く前）", async () => {
    h.isAiEnabled.mockReturnValue(false);
    const res = await respondWithAssistantChat(ARGS, req({ messages: USER_TURN }), deps([]));
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("messages 不正は 400 JSON（SSE を開く前）", async () => {
    const res = await respondWithAssistantChat(ARGS, req({ messages: [] }), deps([]));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid" });
  });

  it("正常: meta → message(delta) → draft → done を送り、監査を 1 回書く", async () => {
    const d = deps([
      { reply: "了解" },
      { reply: "了解、1限を数学にしました", schedules: [{ period: 1, subject: "数学" }] },
    ]);
    const res = await respondWithAssistantChat(ARGS, req({ messages: USER_TURN }), d);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const fr = await frames(res);
    expect(fr[0]).toEqual({
      event: "meta",
      data: {
        pattern: "pattern1",
        allowedSections: ["schedules", "notices", "assignments"],
        manualSections: [],
      },
    });
    const deltas = fr
      .filter((f) => f.event === "message")
      .map((f) => (f.data as { delta: string }).delta);
    expect(deltas.join("")).toBe("了解、1限を数学にしました");
    const drafts = fr.filter((f) => f.event === "draft");
    expect(drafts.at(-1)?.data).toEqual({
      schedules: [{ period: 1, subject: "数学" }],
      notices: [],
      assignments: [],
    });
    const done = fr.find((f) => f.event === "done");
    expect((done?.data as { draft: unknown }).draft).toEqual({
      schedules: [{ period: 1, subject: "数学" }],
      notices: [],
      assignments: [],
    });
    expect(h.insertValues).toHaveBeenCalledOnce();
  });

  it("氏名らしき語があり未 override なら pii_warning（生成せず・監査なし）", async () => {
    h.findSuspectedPersonalNames.mockReturnValue([{ surface: "田中さん" }]);
    const d = deps([{ reply: "x" }]);
    const res = await respondWithAssistantChat(
      ARGS,
      req({ messages: [{ role: "user", content: "田中さんを呼んで" }] }),
      d,
    );
    const fr = await frames(res);
    expect(fr.find((f) => f.event === "error")?.data).toEqual({
      status: 409,
      reason: "pii_warning",
      suspectedSurfaces: ["田中さん"],
    });
    expect(d.streamClient.stream).not.toHaveBeenCalled();
    expect(h.insertValues).not.toHaveBeenCalled();
  });

  it("assistant ターンや下書きに混入した名前も soft-gate で捕捉する（送信サーフェス全体を走査・Reviewer HIGH）", async () => {
    // 入力に依存して検出するフェイク（gate が user ターンだけでなく送信文字列全体を見ていることを証明）。
    h.findSuspectedPersonalNames.mockImplementation((t: string) =>
      t.includes("田中太郎") ? [{ surface: "田中太郎" }] : [],
    );
    const d = deps([{ reply: "x" }]);
    // 名前は assistant ターンに混入、user ターンは無害。旧実装（user ターンのみ走査）なら素通りした。
    const res = await respondWithAssistantChat(
      ARGS,
      req({
        messages: [
          { role: "assistant", content: "田中太郎さんは欠席です" },
          { role: "user", content: "予定を作って" },
        ],
      }),
      d,
    );
    const fr = await frames(res);
    expect(fr.find((f) => f.event === "error")?.data).toMatchObject({
      status: 409,
      reason: "pii_warning",
    });
    expect(d.streamClient.stream).not.toHaveBeenCalled();
  });

  it("レート制限超過は rate_limited（生成しない）", async () => {
    const d = deps([{ reply: "x" }], { acquire: false });
    const res = await respondWithAssistantChat(ARGS, req({ messages: USER_TURN }), d);
    const fr = await frames(res);
    expect(fr.find((f) => f.event === "error")?.data).toMatchObject({
      status: 429,
      reason: "rate_limited",
    });
    expect(d.streamClient.stream).not.toHaveBeenCalled();
  });

  it("マスク後に PII 残存なら pii_leak（送信しない）", async () => {
    h.findUnmaskedPii.mockReturnValue(["09012345678"]);
    const d = deps([{ reply: "x" }]);
    const res = await respondWithAssistantChat(ARGS, req({ messages: USER_TURN }), d);
    const fr = await frames(res);
    expect(fr.find((f) => f.event === "error")?.data).toMatchObject({
      status: 422,
      reason: "pii_leak",
    });
    expect(d.streamClient.stream).not.toHaveBeenCalled();
  });

  it("reply も下書きも空なら no_result（監査なし）", async () => {
    const d = deps([{ reply: "" }]);
    const res = await respondWithAssistantChat(ARGS, req({ messages: USER_TURN }), d);
    const fr = await frames(res);
    expect(fr.find((f) => f.event === "error")?.data).toMatchObject({
      status: 422,
      reason: "no_result",
    });
    expect(h.insertValues).not.toHaveBeenCalled();
  });

  it("ストリーム途中失敗は stream_failed", async () => {
    const d = deps(["THROW"]);
    const res = await respondWithAssistantChat(ARGS, req({ messages: USER_TURN }), d);
    const fr = await frames(res);
    expect(fr.find((f) => f.event === "error")?.data).toMatchObject({
      status: 500,
      reason: "stream_failed",
    });
  });

  it("モデルが無応答でストールしたら中断して stream_failed に畳む（#982 本番ハング対策）", async () => {
    const d = {
      streamClient: hangingStreamClient(),
      rateLimiter: { tryAcquire: vi.fn().mockResolvedValue(true) },
      nowMs: 1000,
      streamStallMs: 20, // テストは小さいストール上限で中断挙動を素早く検証する。
    };
    const res = await respondWithAssistantChat(ARGS, req({ messages: USER_TURN }), d);
    const fr = await frames(res);
    // meta は送られるが、done は無く、ストール中断で stream_failed に畳まれる（永久に開きっぱなしにしない）。
    expect(fr[0]?.event).toBe("meta");
    expect(fr.find((f) => f.event === "done")).toBeUndefined();
    expect(fr.find((f) => f.event === "error")?.data).toMatchObject({
      status: 500,
      reason: "stream_failed",
    });
    // handler は無応答 client を実際に中断しようとした（abort 配線の確認）。
    const sentReq = d.streamClient.stream.mock.calls[0]?.[0] as { signal?: AbortSignal };
    expect(sentReq.signal).toBeInstanceOf(AbortSignal);
  });

  it("許可外セクションの出力は落とす（pattern2 相当・schedules のみ許可）", async () => {
    const d = deps([
      { reply: "ok", schedules: [{ period: 1, subject: "数学" }], notices: [{ text: "連絡" }] },
    ]);
    const res = await respondWithAssistantChat(
      { ...ARGS, allowedSections: ["schedules"], pattern: "pattern2" },
      req({ messages: USER_TURN }),
      d,
    );
    const fr = await frames(res);
    const lastDraft = fr.filter((f) => f.event === "draft").at(-1)?.data as {
      schedules: unknown[];
      notices: unknown[];
    };
    expect(lastDraft.schedules).toHaveLength(1);
    expect(lastDraft.notices).toEqual([]);
  });

  it("手入力セクションは meta に載せ、system プロンプトに手入力誘導を入れる（pattern2・ADR-034）", async () => {
    const d = deps([{ reply: "ok", schedules: [{ period: 1, subject: "数学" }] }]);
    const res = await respondWithAssistantChat(
      {
        ...ARGS,
        allowedSections: ["schedules"],
        pattern: "pattern2",
        manualSectionLabels: ["生徒呼び出し", "来校者一覧"],
      },
      req({ messages: USER_TURN }),
      d,
    );
    const fr = await frames(res);
    // meta に手入力セクションが載る（UI が導線を出せる）。
    expect((fr[0]?.data as { manualSections: string[] }).manualSections).toEqual([
      "生徒呼び出し",
      "来校者一覧",
    ]);
    // Vertex に送る system プロンプトに「AIで作らず手入力フォームへ」の誘導が入る。
    const sentSystem = (d.streamClient.stream.mock.calls[0]?.[0] as { system: string }).system;
    expect(sentSystem).toContain("生徒呼び出し・来校者一覧");
    expect(sentSystem).toContain("手入力フォームから追加してください");
  });
});
