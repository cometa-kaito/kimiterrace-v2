import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NoticeDraftElement } from "@kimiterrace/ai";

/**
 * 段C+（#243 ②UI-UX, ADR-033）: respondWithNoticeDraftStream の SSE 配線・セキュリティ分岐検証。
 * DB / Vertex / PII helper はモック、stream client / rate limiter は deps 注入。kill-switch・ボディ検証・
 * PII soft-gate・レート制限・要素単位 fail-closed・正常ストリーム・監査書込・no_result・stream_failed を固める。
 */

const h = vi.hoisted(() => ({
  isAiEnabled: vi.fn(),
  findSuspectedPersonalNames: vi.fn(),
  findUnmaskedPii: vi.fn(),
  maskPII: vi.fn(),
  unmaskPII: vi.fn(),
  insertValues: vi.fn(),
}));

vi.mock("@/lib/ai/ai-enabled", () => ({ isAiEnabled: h.isAiEnabled }));
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("@kimiterrace/db", () => ({
  auditLog: {},
  // withTenantContext(db, ctx, cb) → cb(fakeTx)。tx.insert().values() を spy で観測。
  withTenantContext: (_db: unknown, _ctx: unknown, cb: (tx: unknown) => unknown) =>
    cb({ insert: () => ({ values: h.insertValues }) }),
}));
vi.mock("@kimiterrace/ai", () => ({
  findSuspectedPersonalNames: h.findSuspectedPersonalNames,
  findUnmaskedPii: h.findUnmaskedPii,
  maskPII: h.maskPII,
  unmaskPII: h.unmaskPII,
  createPerSchoolRateLimiter: () => ({ tryAcquire: () => true }),
  createVertexNoticeStreamClient: () => ({ stream: () => ({}) }),
}));

import {
  NOTICE_ASSIST_STREAM_SYSTEM,
  NOTICE_TONE_INSTRUCTIONS,
} from "../../lib/editor/assistant-core";
import { respondWithNoticeDraftStream } from "../../lib/editor/notice-draft-sse";

const CLASS_ID = "11111111-1111-4111-8111-111111111111";
const ARGS = {
  target: { scope: "class", classId: CLASS_ID },
  actor: { userId: "u1", schoolId: "s1" },
  tenantContext: { userId: "u1", schoolId: "s1", role: "teacher" },
} as const;

/** scope/targetId はクエリ、text/acknowledgePii はボディ（handler が読む）。 */
function req(body: unknown, rawBody?: string): Request {
  return new Request(`https://x/api/editor/notice-draft?scope=class&targetId=${CLASS_ID}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: rawBody ?? JSON.stringify(body),
  });
}

/** 注入する stream client。elements を順に yield（"THROW" は途中失敗を模す）。 */
function fakeStreamClient(elements: (NoticeDraftElement | "THROW")[]) {
  const stream = vi.fn((_req: { system: string; user: string; signal?: AbortSignal }) => ({
    elementStream: (async function* () {
      for (const e of elements) {
        if (e === "THROW") throw new Error("boom");
        yield e;
      }
    })(),
    done: Promise.resolve({ modelVersion: "fake", tokenCount: 3 }),
  }));
  return { stream };
}

/**
 * 要素を一切 yield せず signal.abort まで待つ stream client（実 streamObject の無応答ハング + 中断挙動を模す）。
 * handler のストール監視（streamStallMs 経過 → stallController.abort）で reject → for-await が throw する。
 */
function hangingStreamClient() {
  const stream = vi.fn((reqArg: { system: string; user: string; signal?: AbortSignal }) => ({
    elementStream: (async function* (): AsyncGenerator<NoticeDraftElement> {
      await new Promise<void>((_resolve, reject) => {
        reqArg.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    })(),
    done: Promise.resolve({ modelVersion: "fake", tokenCount: 0 }),
  }));
  return { stream };
}

function deps(o: { elements?: (NoticeDraftElement | "THROW")[]; acquire?: boolean } = {}) {
  return {
    streamClient: fakeStreamClient(o.elements ?? [{ text: "連絡A", isHighlight: false }]),
    rateLimiter: { tryAcquire: vi.fn().mockReturnValue(o.acquire ?? true) },
    nowMs: 1000,
  };
}

/** SSE Response 本文を {event,data} 配列へ。 */
async function collectSse(
  res: Response,
): Promise<{ event: string; data: Record<string, unknown> }[]> {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((f) => f.trim().length > 0)
    .map((frame) => {
      const lines = frame.split("\n");
      const event =
        lines
          .find((l) => l.startsWith("event:"))
          ?.slice(6)
          .trim() ?? "";
      const dataLine =
        lines
          .find((l) => l.startsWith("data:"))
          ?.slice(5)
          .trim() ?? "{}";
      return { event, data: JSON.parse(dataLine) as Record<string, unknown> };
    });
}

beforeEach(() => {
  h.isAiEnabled.mockReset().mockReturnValue(true);
  h.findSuspectedPersonalNames.mockReset().mockReturnValue([]);
  h.findUnmaskedPii.mockReset().mockReturnValue([]);
  h.maskPII.mockReset().mockImplementation((t: string) => ({ masked: t, dictionary: {} }));
  h.unmaskPII.mockReset().mockImplementation((t: string) => t);
  h.insertValues.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.clearAllMocks());

describe("respondWithNoticeDraftStream", () => {
  it("AI_ENABLED OFF は 503 ai_disabled（SSE を開かない）", async () => {
    h.isAiEnabled.mockReturnValue(false);
    const res = await respondWithNoticeDraftStream(ARGS, req({ text: "連絡" }), deps());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "ai_disabled" });
  });

  it("不正 JSON は 400 invalid_json", async () => {
    const res = await respondWithNoticeDraftStream(ARGS, req(null, "{bad"), deps());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_json" });
  });

  it("空入力は 400 empty", async () => {
    const res = await respondWithNoticeDraftStream(ARGS, req({ text: "   " }), deps());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "empty" });
  });

  it("氏名らしき語があり未 override なら pii_warning（送信しない・SSE error）", async () => {
    h.findSuspectedPersonalNames.mockReturnValue([
      { surface: "田中さん" },
      { surface: "田中さん" },
    ]);
    const d = deps();
    const res = await respondWithNoticeDraftStream(ARGS, req({ text: "田中さんが欠席" }), d);
    expect(res.status).toBe(200);
    const evs = await collectSse(res);
    expect(evs).toEqual([
      {
        event: "error",
        data: { status: 409, reason: "pii_warning", suspectedSurfaces: ["田中さん"] },
      },
    ]);
    expect(d.streamClient.stream).not.toHaveBeenCalled();
  });

  it("acknowledgePii で soft-gate を越えてストリーミングする", async () => {
    h.findSuspectedPersonalNames.mockReturnValue([{ surface: "田中さん" }]);
    const d = deps({ elements: [{ text: "連絡X", isHighlight: true }] });
    const res = await respondWithNoticeDraftStream(
      ARGS,
      req({ text: "連絡を作って", acknowledgePii: true }),
      d,
    );
    const evs = await collectSse(res);
    expect(d.streamClient.stream).toHaveBeenCalledOnce();
    expect(evs.map((e) => e.event)).toEqual(["notice", "done"]);
    expect(evs[0]?.data).toEqual({ index: 0, text: "連絡X", isHighlight: true });
  });

  it("レート制限超過は rate_limited（送信しない）", async () => {
    const d = deps({ acquire: false });
    const res = await respondWithNoticeDraftStream(ARGS, req({ text: "連絡" }), d);
    const evs = await collectSse(res);
    expect(evs).toEqual([{ event: "error", data: { status: 429, reason: "rate_limited" } }]);
    expect(d.streamClient.stream).not.toHaveBeenCalled();
  });

  it("マスク後に PII 残存なら pii_leak（送信しない）", async () => {
    h.findUnmaskedPii.mockReturnValueOnce([{ kind: "phone" }]); // マスク直後の検査でヒット
    const d = deps();
    const res = await respondWithNoticeDraftStream(ARGS, req({ text: "電話 09012345678" }), d);
    const evs = await collectSse(res);
    expect(evs).toEqual([{ event: "error", data: { status: 422, reason: "pii_leak" } }]);
    expect(d.streamClient.stream).not.toHaveBeenCalled();
  });

  it("正常時は notice を 1 件ずつ送出し、done と audit_log 書込で終える", async () => {
    const d = deps({
      elements: [
        { text: "明日は短縮授業です。", isHighlight: false },
        { text: "図書室の返却は金曜まで。", isHighlight: true },
      ],
    });
    const res = await respondWithNoticeDraftStream(ARGS, req({ text: "メモ" }), d);
    const evs = await collectSse(res);
    expect(evs).toEqual([
      { event: "notice", data: { index: 0, text: "明日は短縮授業です。", isHighlight: false } },
      { event: "notice", data: { index: 1, text: "図書室の返却は金曜まで。", isHighlight: true } },
      { event: "done", data: { count: 2 } },
    ]);
    expect(h.insertValues).toHaveBeenCalledOnce();
    // system はストリーミング用プロンプト（JSON エンベロープを指示しない版）。
    expect(d.streamClient.stream.mock.calls[0]?.[0]?.system).toBe(NOTICE_ASSIST_STREAM_SYSTEM);
  });

  it("既知の tone は user プロンプトに固定の調整指示を付す（未知 tone は付さない）", async () => {
    const d = deps();
    await collectSse(
      await respondWithNoticeDraftStream(ARGS, req({ text: "メモ", tone: "short" }), d),
    );
    expect(d.streamClient.stream.mock.calls[0]?.[0]?.user).toContain(
      NOTICE_TONE_INSTRUCTIONS.short,
    );

    const d2 = deps();
    await collectSse(
      await respondWithNoticeDraftStream(ARGS, req({ text: "メモ", tone: "evil" }), d2),
    );
    expect(d2.streamClient.stream.mock.calls[0]?.[0]?.user).not.toContain("【調整の指示】");
  });

  it("自由指示は user プロンプトに付し、soft-gate は memo+指示の両方を対象にする", async () => {
    const d = deps();
    await collectSse(
      await respondWithNoticeDraftStream(
        ARGS,
        req({ text: "メモ", instruction: "部活の連絡も足して" }),
        d,
      ),
    );
    expect(d.streamClient.stream.mock.calls[0]?.[0]?.user).toContain("部活の連絡も足して");
    // soft-gate は memo + 自由指示を結合して評価する（指示文の氏名も素通りさせない）。
    expect(h.findSuspectedPersonalNames).toHaveBeenCalledWith(
      expect.stringContaining("部活の連絡も足して"),
    );
  });

  it("自由指示に書式 PII（電話/メール）が含まれれば pii_leak（送信しない）", async () => {
    // 1 回目（memo マスク後）は clean、2 回目（自由指示）でヒット。
    h.findUnmaskedPii.mockReturnValueOnce([]).mockReturnValueOnce([{ kind: "phone" }]);
    const d = deps();
    const res = await respondWithNoticeDraftStream(
      ARGS,
      req({ text: "メモ", instruction: "電話 09012345678 に連絡" }),
      d,
    );
    const evs = await collectSse(res);
    expect(evs).toEqual([{ event: "error", data: { status: 422, reason: "pii_leak" } }]);
    expect(d.streamClient.stream).not.toHaveBeenCalled();
  });

  it("PII 残存した要素だけ notice_redacted で落とし、他は流す", async () => {
    // 2 件目だけ fail-closed ヒット（検査はマスク空間 = el.text に対して行う）。
    h.findUnmaskedPii
      .mockReturnValueOnce([]) // マスク直後（送信前・input）
      .mockReturnValueOnce([]) // 1 件目（マスク空間）
      .mockReturnValueOnce([{ kind: "email" }]); // 2 件目（マスク空間）
    const d = deps({
      elements: [
        { text: "連絡1", isHighlight: false },
        { text: "連絡2 leak", isHighlight: false },
      ],
    });
    const res = await respondWithNoticeDraftStream(ARGS, req({ text: "メモ" }), d);
    const evs = await collectSse(res);
    expect(evs).toEqual([
      { event: "notice", data: { index: 0, text: "連絡1", isHighlight: false } },
      { event: "notice_redacted", data: { index: 1 } },
      { event: "done", data: { count: 1 } },
    ]);
    expect(h.insertValues).toHaveBeenCalledOnce();
  });

  it("辞書由来 PII 復元値を含む要素は notice_redacted せず流す（マスク空間検査・誤検知解消）", async () => {
    // 教員が連絡に書いた電話をマスク → モデルが token を返す → 逆マスクで復元。復元値は PII 形だが正規（辞書由来）。
    h.maskPII.mockReturnValue({ masked: "メモ", dictionary: { "{{PHONE_1}}": "09012345678" } });
    h.findUnmaskedPii.mockImplementation((s: string) =>
      s.includes("09012345678") ? ["09012345678"] : [],
    );
    h.unmaskPII.mockImplementation((s: string) => s.replace("{{PHONE_1}}", "09012345678"));
    const d = deps({ elements: [{ text: "連絡先 {{PHONE_1}}", isHighlight: false }] });
    const res = await respondWithNoticeDraftStream(ARGS, req({ text: "メモ" }), d);
    const evs = await collectSse(res);
    expect(evs).toEqual([
      { event: "notice", data: { index: 0, text: "連絡先 09012345678", isHighlight: false } },
      { event: "done", data: { count: 1 } },
    ]);
  });

  it("モデルが生成した辞書に無い生 PII の要素は引き続き notice_redacted（検出力維持）", async () => {
    h.maskPII.mockReturnValue({ masked: "メモ", dictionary: {} });
    h.findUnmaskedPii.mockImplementation((s: string) =>
      s.includes("08099998888") ? ["08099998888"] : [],
    );
    const d = deps({ elements: [{ text: "電話 08099998888", isHighlight: false }] });
    const res = await respondWithNoticeDraftStream(ARGS, req({ text: "メモ" }), d);
    const evs = await collectSse(res);
    expect(evs).toEqual([
      { event: "notice_redacted", data: { index: 0 } },
      { event: "error", data: { status: 422, reason: "no_result" } },
    ]);
  });

  it("有効な連絡が 0 件なら no_result（audit しない）", async () => {
    const d = deps({ elements: [] });
    const res = await respondWithNoticeDraftStream(ARGS, req({ text: "メモ" }), d);
    const evs = await collectSse(res);
    expect(evs).toEqual([{ event: "error", data: { status: 422, reason: "no_result" } }]);
    expect(h.insertValues).not.toHaveBeenCalled();
  });

  it("ストリーム途中の障害は stream_failed（既送出分は保持）", async () => {
    const d = deps({ elements: [{ text: "連絡1", isHighlight: false }, "THROW"] });
    const res = await respondWithNoticeDraftStream(ARGS, req({ text: "メモ" }), d);
    const evs = await collectSse(res);
    expect(evs[0]).toEqual({
      event: "notice",
      data: { index: 0, text: "連絡1", isHighlight: false },
    });
    expect(evs[1]?.event).toBe("error");
    expect(evs[1]?.data?.reason).toBe("stream_failed");
    expect(h.insertValues).not.toHaveBeenCalled();
  });

  it("初回要素が来ない無応答ストールは streamStallMs 経過で中断し stream_failed（#987・audit しない）", async () => {
    const d = {
      streamClient: hangingStreamClient(),
      rateLimiter: { tryAcquire: vi.fn().mockReturnValue(true) },
      nowMs: 1000,
      streamStallMs: 20, // 小さい値で無応答ストール中断を誘発。
    };
    const res = await respondWithNoticeDraftStream(ARGS, req({ text: "メモ" }), d);
    const evs = await collectSse(res);
    expect(d.streamClient.stream).toHaveBeenCalledOnce();
    // signal を stream client に渡している（ストール時に handler が Vertex を能動中断できる）。
    expect(d.streamClient.stream.mock.calls[0]?.[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(evs).toEqual([
      {
        event: "error",
        data: { status: 500, reason: "stream_failed", message: "応答の生成に失敗しました。" },
      },
    ]);
    expect(h.insertValues).not.toHaveBeenCalled();
  });
});
