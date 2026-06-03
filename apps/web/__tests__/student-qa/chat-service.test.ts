import { beforeEach, describe, expect, it, vi } from "vitest";

// 永続化層は mock する (実 DB を使わない、ADR-012)。tx は素通しのスタブで良い。
vi.mock("../../lib/student-qa/persistence", () => ({
  findOrCreateSession: vi.fn(),
  findOrCreateSessionForUser: vi.fn(),
  appendUserMessage: vi.fn(),
  appendAssistantMessage: vi.fn(),
}));

import type { TenantTx } from "@kimiterrace/db";
import type { PiiEntry } from "@kimiterrace/ai";
import {
  type ChatStreamClient,
  type ContextProvider,
  type ExecuteChatParams,
  executeChat,
} from "../../lib/student-qa/chat-service";
import {
  appendAssistantMessage,
  appendUserMessage,
  findOrCreateSession,
  findOrCreateSessionForUser,
} from "../../lib/student-qa/persistence";
import { studentQaRateLimiter, teacherQaRateLimiter } from "../../lib/student-qa/rate-limit";
import { OUT_OF_SCOPE_REPLY } from "../../lib/student-qa/scope";

/**
 * F06 (#42 第2スライス, #373): 生徒対話オーケストレーション層 `executeChat` の決定的検証。
 *
 * 実 Vertex / 実 DB 不使用: modelClient / contextProvider はフェイク注入、persistence は vi.mock。
 * **PII マスキング (ルール4)** は実 `@kimiterrace/ai` `maskPII` を通し、生 PII が Vertex プロンプト /
 * DB 保存テキストへ漏れないことを実挙動で検証する。rate-limit は実シングルトンを reset して使う。
 */

const SCHOOL_ID = "00000000-0000-0000-0000-0000000000aa";
const CLASS_ID = "00000000-0000-0000-0000-0000000000bb";
const MAGIC_LINK_ID = "00000000-0000-0000-0000-0000000000cc";
const USER_ID = "00000000-0000-0000-0000-0000000000dd";

/** チャンク列とフル本文を返すフェイク `ChatStreamClient`。最後に受け取った req を `state` で覗ける。 */
function makeModelClient(opts: {
  chunks: string[];
  fullText?: string;
  modelVersion?: string;
  tokenCount?: number;
}): { client: ChatStreamClient; state: { req: { system: string; user: string } | null } } {
  const state: { req: { system: string; user: string } | null } = { req: null };
  const client: ChatStreamClient = {
    stream(req) {
      state.req = req;
      return {
        textStream: (async function* () {
          for (const c of opts.chunks) yield c;
        })(),
        done: Promise.resolve({
          fullText: opts.fullText ?? opts.chunks.join(""),
          modelVersion: opts.modelVersion ?? "gemini-test-001",
          tokenCount: opts.tokenCount ?? 7,
        }),
      };
    },
  };
  return { client, state };
}

/** `textStream` を結合する。 */
async function collect(stream: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const c of stream) out += c;
  return out;
}

function baseParams(overrides: Partial<ExecuteChatParams> = {}): ExecuteChatParams {
  const { client } = makeModelClient({ chunks: ["はい", "、体育祭は晴れです"] });
  const ctx: ContextProvider = vi.fn(async () => [
    { id: "c1", title: "体育祭のお知らせ", body: "6/10 開催、雨天順延。" },
  ]);
  return {
    tx: {} as TenantTx,
    schoolId: SCHOOL_ID,
    identity: {
      kind: "student",
      magicLinkId: MAGIC_LINK_ID,
      classId: CLASS_ID,
      cookieId: "cookie-abc",
    },
    rawQuestion: "体育祭はいつですか？",
    piiEntries: [],
    contextProvider: ctx,
    modelClient: client,
    nowMs: 1_000,
    ...overrides,
  };
}

/** 教員経路の baseParams (identity=teacher、#370)。 */
function teacherParams(overrides: Partial<ExecuteChatParams> = {}): ExecuteChatParams {
  return baseParams({
    identity: { kind: "teacher", userId: USER_ID },
    ...overrides,
  });
}

beforeEach(() => {
  studentQaRateLimiter.reset();
  teacherQaRateLimiter.reset();
  vi.clearAllMocks();
  vi.mocked(findOrCreateSession).mockResolvedValue({
    id: "sess-1",
    schoolId: SCHOOL_ID,
    magicLinkId: MAGIC_LINK_ID,
    // 生徒経路のセッションなので user_id は null（#370 XOR）。
    userId: null,
    classId: CLASS_ID,
  });
  vi.mocked(findOrCreateSessionForUser).mockResolvedValue({
    id: "sess-t1",
    schoolId: SCHOOL_ID,
    // 教員経路のセッションは user_id のみ（magic_link/class は null、#370 XOR）。
    magicLinkId: null,
    userId: USER_ID,
    classId: null,
  });
  vi.mocked(appendUserMessage).mockResolvedValue({ id: "umsg-1" });
  vi.mocked(appendAssistantMessage).mockResolvedValue({ id: "amsg-1" });
});

describe("executeChat: 正常系 (SSE stream + 永続化)", () => {
  it("チャンクを素通しし、user→assistant を RLS tx 内で永続化する", async () => {
    const { client, state } = makeModelClient({
      chunks: ["体育祭は", "6/10 です"],
      modelVersion: "gemini-test-002",
      tokenCount: 12,
    });
    const result = await executeChat(baseParams({ modelClient: client }));
    expect(result.kind).toBe("stream");
    if (result.kind !== "stream") return;

    expect(await collect(result.textStream)).toBe("体育祭は6/10 です");
    expect(await result.done).toEqual({ assistantMessageId: "amsg-1", sessionId: "sess-1" });

    // session は (schoolId, magicLinkId, classId) で解決される。
    expect(findOrCreateSession).toHaveBeenCalledWith(expect.anything(), {
      schoolId: SCHOOL_ID,
      magicLinkId: MAGIC_LINK_ID,
      classId: CLASS_ID,
    });
    // user メッセージは応答前に書かれる (失敗時も入力が残る)。
    expect(appendUserMessage).toHaveBeenCalledWith(expect.anything(), {
      schoolId: SCHOOL_ID,
      sessionId: "sess-1",
      maskedText: "体育祭はいつですか？",
      tokenCount: 0,
    });
    // assistant は fullText + usage + evidence/confidence/model_version を載せる。
    expect(appendAssistantMessage).toHaveBeenCalledWith(expect.anything(), {
      schoolId: SCHOOL_ID,
      sessionId: "sess-1",
      maskedText: "体育祭は6/10 です",
      modelVersion: "gemini-test-002",
      evidence: [{ contentId: "c1", title: "体育祭のお知らせ" }],
      confidenceScore: 0.4,
      tokenCount: 12,
    });
    // system プロンプトはスコープ拒否契約を含む。
    expect(state.req?.system).toContain("掲示物");
  });

  it("context 0 件のとき confidence は 0、prompt は「該当なし」を含む", async () => {
    const { client, state } = makeModelClient({ chunks: ["掲示物が見つかりません"] });
    const result = await executeChat(
      baseParams({ modelClient: client, contextProvider: async () => [] }),
    );
    expect(result.kind).toBe("stream");
    if (result.kind !== "stream") return;
    await collect(result.textStream);
    await result.done;
    expect(vi.mocked(appendAssistantMessage).mock.calls[0]?.[1].confidenceScore).toBe(0);
    expect(vi.mocked(appendAssistantMessage).mock.calls[0]?.[1].evidence).toEqual([]);
    expect(state.req?.user).toContain("見つかりませんでした");
  });
});

describe("executeChat: grounding モード切替 (ADR-028 §3)", () => {
  it("provider が grounded を申告: 掲示準拠 system + 件数ベース confidence", async () => {
    const { client, state } = makeModelClient({ chunks: ["体育祭は6/10です"] });
    const result = await executeChat(
      baseParams({
        modelClient: client,
        contextProvider: async () => ({
          mode: "grounded",
          contexts: [{ id: "c1", title: "体育祭", body: "6/10 開催" }],
        }),
      }),
    );
    expect(result.kind).toBe("stream");
    if (result.kind !== "stream") return;
    await collect(result.textStream);
    await result.done;
    // grounded は強調ブロックを付けない（従来 base 契約のまま）。
    expect(state.req?.system).not.toContain("ラベル付きの一般補足モード");
    // grounded は件数ベースで confidence を積む（1 件 → 0.4）。
    expect(vi.mocked(appendAssistantMessage).mock.calls[0]?.[1].confidenceScore).toBe(0.4);
  });

  it("provider が general_supplement を申告: ラベル付き一般補足 system + confidence 0", async () => {
    const { client, state } = makeModelClient({ chunks: ["掲示には無い一般的な情報です。…"] });
    const result = await executeChat(
      baseParams({
        modelClient: client,
        // 非空文脈でも general_supplement なら自信を捏造しない（意味的根拠未検証）。
        contextProvider: async () => ({
          mode: "general_supplement",
          contexts: [{ id: "c1", title: "最近の掲示", body: "本文" }],
        }),
      }),
    );
    expect(result.kind).toBe("stream");
    if (result.kind !== "stream") return;
    await collect(result.textStream);
    await result.done;
    // system は一般補足モードの強調ブロックを含む（ADR-028 §3）。
    expect(state.req?.system).toContain("ラベル付きの一般補足モード");
    expect(state.req?.system).toContain("掲示には無い一般的な情報です");
    expect(state.req?.system).toContain("学校固有の事実は推測で生成しない");
    expect(state.req?.system).toContain("先生に確認してください");
    // 一般補足は意味的根拠未検証ゆえ confidence 0（非空文脈でも自信を捏造しない）。
    expect(vi.mocked(appendAssistantMessage).mock.calls[0]?.[1].confidenceScore).toBe(0);
  });

  it("素の配列を返すレガシー provider は非空=grounded に畳む（後方互換）", async () => {
    const { client, state } = makeModelClient({ chunks: ["はい"] });
    await executeChat(
      baseParams({
        modelClient: client,
        contextProvider: async () => [{ id: "c1", title: "体育祭", body: "6/10" }],
      }),
    );
    expect(state.req?.system).not.toContain("ラベル付きの一般補足モード");
    expect(vi.mocked(appendAssistantMessage).mock.calls[0]?.[1].confidenceScore).toBe(0.4);
  });
});

describe("executeChat: PII マスキング (ルール4)", () => {
  it("質問内の電話番号は Vertex プロンプト・DB 保存テキストから除去される (検出は既定 ON)", async () => {
    const { client, state } = makeModelClient({ chunks: ["了解しました"] });
    const result = await executeChat(
      baseParams({
        modelClient: client,
        rawQuestion: "連絡先は 090-1234-5678 です、体育祭の場所は？",
      }),
    );
    expect(result.kind).toBe("stream");
    if (result.kind !== "stream") return;
    await collect(result.textStream);
    await result.done;

    // 生の電話番号は Vertex へ渡る user プロンプトに出現しない。
    expect(state.req?.user).not.toContain("090-1234-5678");
    // DB へ保存する user メッセージにも生 PII は無い。
    const savedUser = vi.mocked(appendUserMessage).mock.calls[0]?.[1].maskedText ?? "";
    expect(savedUser).not.toContain("090-1234-5678");
  });

  it("名簿エントリ (生徒氏名) は質問・context・evidence からトークン化される", async () => {
    const piiEntries: PiiEntry[] = [{ value: "田中太郎", category: "STUDENT" }];
    const { client, state } = makeModelClient({ chunks: ["はい"] });
    const result = await executeChat(
      baseParams({
        modelClient: client,
        piiEntries,
        rawQuestion: "田中太郎の出欠は掲示にありますか？",
        contextProvider: async () => [
          { id: "c1", title: "田中太郎 連絡", body: "田中太郎は本日欠席。" },
        ],
      }),
    );
    expect(result.kind).toBe("stream");
    if (result.kind !== "stream") return;
    await collect(result.textStream);
    await result.done;

    // Vertex プロンプトにもユーザ入力にも context にも生氏名が残らない。
    expect(state.req?.user).not.toContain("田中太郎");
    expect(vi.mocked(appendUserMessage).mock.calls[0]?.[1].maskedText).not.toContain("田中太郎");
    // evidence (DB 保存) の title もマスク後 (ルール4: DB 保存もマスキング後)。
    const evidence = vi.mocked(appendAssistantMessage).mock.calls[0]?.[1].evidence ?? [];
    expect(JSON.stringify(evidence)).not.toContain("田中太郎");
  });

  it("contextProvider にはマスク済み質問が渡る (RAG が生 PII を embedding しない)", async () => {
    const ctx: ContextProvider = vi.fn(async () => []);
    const { client } = makeModelClient({ chunks: ["はい"] });
    await executeChat(
      baseParams({
        modelClient: client,
        contextProvider: ctx,
        rawQuestion: "連絡先 090-1234-5678 の件、体育祭の場所は？",
      }),
    );
    expect(ctx).toHaveBeenCalledTimes(1);
    const passed = vi.mocked(ctx).mock.calls[0]?.[1];
    expect(passed?.audience).toEqual({ kind: "student", classId: CLASS_ID });
    // RAG が embedding 化する前提なので、provider へ渡る質問に生 PII (電話) は含まない。
    expect(passed?.maskedQuestion).not.toContain("090-1234-5678");
    expect(passed?.maskedQuestion).toContain("体育祭");
  });
});

describe("executeChat: 拒否系", () => {
  it("空質問は 400 empty、LLM も永続化も呼ばない", async () => {
    const result = await executeChat(baseParams({ rawQuestion: "   " }));
    expect(result).toMatchObject({ kind: "rejected", status: 400, reason: "empty" });
    expect(findOrCreateSession).not.toHaveBeenCalled();
    expect(appendUserMessage).not.toHaveBeenCalled();
  });

  it("長すぎる質問は 400 too_long", async () => {
    const result = await executeChat(baseParams({ rawQuestion: "あ".repeat(501) }));
    expect(result).toMatchObject({ kind: "rejected", status: 400, reason: "too_long" });
  });

  it("レート上限 (10/分) 超過は 429、上限内は許可", async () => {
    // 同一 magic_link / cookie / 窓 (nowMs 固定) で 10 回まで許可、11 回目で拒否。
    for (let i = 0; i < 10; i++) {
      const r = await executeChat(baseParams());
      expect(r.kind).toBe("stream");
    }
    const denied = await executeChat(baseParams());
    expect(denied).toMatchObject({ kind: "rejected", status: 429 });
    if (denied.kind === "rejected") {
      expect(denied.reason.startsWith("rate_limited_")).toBe(true);
    }
  });
});

describe("executeChat: スコープ外フォールバック", () => {
  it("空ストリーム (モデルが応答しない) でも assistant 1 行に定型拒否文を残す", async () => {
    const { client } = makeModelClient({ chunks: [], fullText: "" });
    const result = await executeChat(baseParams({ modelClient: client }));
    expect(result.kind).toBe("stream");
    if (result.kind !== "stream") return;
    expect(await collect(result.textStream)).toBe("");
    await result.done;
    expect(vi.mocked(appendAssistantMessage).mock.calls[0]?.[1].maskedText).toBe(
      OUT_OF_SCOPE_REPLY,
    );
  });
});

describe("executeChat: スコープ分類ゲート (ADR-028 §2 pre-Gemini)", () => {
  it("学習・進路の質問は RAG/Gemini を呼ばず決定論拒否文を stream + 永続化する", async () => {
    const { client, state } = makeModelClient({ chunks: ["これは呼ばれない"] });
    const ctx: ContextProvider = vi.fn(async () => []);
    const result = await executeChat(
      baseParams({
        modelClient: client,
        contextProvider: ctx,
        // career → out_of_scope (志望校 / 受験勉強)。
        rawQuestion: "志望校の受験勉強について相談したいです",
      }),
    );
    expect(result.kind).toBe("stream");
    if (result.kind !== "stream") return;
    const text = await collect(result.textStream);
    await result.done;

    // 決定論の ja 拒否文。
    expect(text).toContain("掲示物の話題から外れます");
    // **RAG (contextProvider) も Gemini (modelClient.stream) も呼ばれない** = embedding/生成コスト 0。
    expect(ctx).not.toHaveBeenCalled();
    expect(state.req).toBeNull();
    // 履歴・監査のため user/assistant は永続化される。assistant=拒否文 / evidence 空 / confidence 0 /
    // model_version は拒否センチネル。
    expect(appendUserMessage).toHaveBeenCalled();
    const asst = vi.mocked(appendAssistantMessage).mock.calls[0]?.[1];
    expect(asst?.maskedText).toContain("掲示物の話題から外れます");
    expect(asst?.evidence).toEqual([]);
    expect(asst?.confidenceScore).toBe(0);
    expect(asst?.modelVersion).toContain("scope-refusal");
  });

  it("locale=en のスコープ外質問は英語の拒否文を返す (多言語、Gemini 非経由)", async () => {
    const { client, state } = makeModelClient({ chunks: ["x"] });
    const result = await executeChat(
      baseParams({
        modelClient: client,
        // study (homework) → out_of_scope。
        rawQuestion: "please help me with my homework",
        locale: "en",
      }),
    );
    expect(result.kind).toBe("stream");
    if (result.kind !== "stream") return;
    expect(await collect(result.textStream)).toContain("school notices");
    await result.done;
    // 注入した client が **呼ばれない** ことで Gemini 非経由を非空虚に証明 (#506 Low-1)。
    expect(state.req).toBeNull();
  });

  it("掲示物の質問 (in_scope) は通常の RAG + Gemini 経路に進む", async () => {
    const { client, state } = makeModelClient({ chunks: ["体育祭は6/10です"] });
    const ctx: ContextProvider = vi.fn(async () => [
      { id: "c1", title: "体育祭", body: "6/10 開催" },
    ]);
    const result = await executeChat(
      baseParams({
        modelClient: client,
        contextProvider: ctx,
        rawQuestion: "体育祭はいつですか？",
      }),
    );
    expect(result.kind).toBe("stream");
    if (result.kind !== "stream") return;
    await collect(result.textStream);
    await result.done;
    // in_scope は RAG + Gemini が呼ばれる (ゲートを素通り)。
    expect(ctx).toHaveBeenCalled();
    expect(state.req).not.toBeNull();
  });
});

describe("executeChat: 教員経路 (identity=teacher, #370)", () => {
  it("user_id でセッションを解決し (magic_link 経路は呼ばない)、staff audience で grounding する", async () => {
    const ctx: ContextProvider = vi.fn(async () => [
      { id: "c1", title: "職員向け掲示", body: "保護者会は 6/20。" },
    ]);
    const { client } = makeModelClient({ chunks: ["保護者会は6/20です"] });
    const result = await executeChat(
      teacherParams({ modelClient: client, contextProvider: ctx, rawQuestion: "保護者会はいつ？" }),
    );
    expect(result.kind).toBe("stream");
    if (result.kind !== "stream") return;
    await collect(result.textStream);
    expect(await result.done).toEqual({ assistantMessageId: "amsg-1", sessionId: "sess-t1" });

    // 教員は user_id キーでセッション解決。生徒経路 (magic_link) は呼ばれない。
    expect(findOrCreateSessionForUser).toHaveBeenCalledWith(expect.anything(), {
      schoolId: SCHOOL_ID,
      userId: USER_ID,
    });
    expect(findOrCreateSession).not.toHaveBeenCalled();
    // 教員はクラス非バインド: contextProvider に staff audience が渡る (#481-2)。
    expect(vi.mocked(ctx).mock.calls[0]?.[1].audience).toEqual({ kind: "staff" });
    // 永続化は教員セッション (sess-t1) に対して行われる。
    expect(vi.mocked(appendUserMessage).mock.calls[0]?.[1].sessionId).toBe("sess-t1");
  });

  it("レート上限は user_id 単一キー (10/分)、11 回目で 429 rate_limited_user", async () => {
    for (let i = 0; i < 10; i++) {
      const r = await executeChat(teacherParams());
      expect(r.kind).toBe("stream");
    }
    const denied = await executeChat(teacherParams());
    expect(denied).toMatchObject({ kind: "rejected", status: 429, reason: "rate_limited_user" });
    // 生徒の二重キー制限とは独立 (同 nowMs でも生徒側は消費されていない)。
    const studentOk = await executeChat(baseParams());
    expect(studentOk.kind).toBe("stream");
  });

  it("スコープ外質問も教員セッション (user_id) に決定論拒否を永続化する", async () => {
    const { client, state } = makeModelClient({ chunks: ["呼ばれない"] });
    const result = await executeChat(
      teacherParams({ modelClient: client, rawQuestion: "志望校の受験勉強の相談に乗って" }),
    );
    expect(result.kind).toBe("stream");
    if (result.kind !== "stream") return;
    expect(await collect(result.textStream)).toContain("掲示物の話題から外れます");
    await result.done;
    // Gemini 非経由 (state.req null)、セッションは user_id 経路で解決。
    expect(state.req).toBeNull();
    expect(findOrCreateSessionForUser).toHaveBeenCalledWith(expect.anything(), {
      schoolId: SCHOOL_ID,
      userId: USER_ID,
    });
    expect(vi.mocked(appendAssistantMessage).mock.calls[0]?.[1].modelVersion).toContain(
      "scope-refusal",
    );
  });
});
