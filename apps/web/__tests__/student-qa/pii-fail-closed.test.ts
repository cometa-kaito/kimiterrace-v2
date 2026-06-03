import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F06 (#511, #42): `executeChat` の **PII マスク漏れ fail-closed 500 経路** の回帰 pin。
 *
 * 背景: chat-service.ts の 6) で context / 質問をマスクした後、`findUnmaskedPii` が漏れを検出すると
 * `{ kind: "rejected", status: 500, reason: "pii_leak" }` を返し **モデルへ生 PII を送らない**
 * (defense-in-depth、ルール4)。この経路は実 `maskPII` がトークン化に成功する限り発火しないため、
 * 既存スイート (chat-service.test.ts / adversarial.test.ts) では未踏のまま残っていた
 * (adversarial.test.ts の該当ケースは「漏れ無し→stream / 漏れ有り→500」の二者択一で、500 を決定的に
 * は踏めない。PR #510 Reviewer Low-1)。
 *
 * 本ファイルは `@kimiterrace/ai` を **部分 mock** し `maskPII` だけを「マスクしたつもりが原文を素通し
 * する」挙動に差し替えることで、500 経路を **決定的に** 発火させる。`findUnmaskedPii` /
 * `buildChatPrompt` / `classifyScope` / `buildScopeRefusal` は **実物のまま** (importActual spread) で、
 * 実 `findUnmaskedPii` が残存 PII を検出 → executeChat が 500 を返すことを実挙動で pin する。
 *
 * 実 Vertex / 実 DB 不使用: modelClient / contextProvider はフェイク注入、persistence は vi.mock、
 * rate-limit は実シングルトンを reset して使う (既存 harness を踏襲)。
 */

// 永続化層は mock (実 DB を使わない、ADR-012)。tx は素通しのスタブで良い。
vi.mock("../../lib/student-qa/persistence", () => ({
  findOrCreateSession: vi.fn(),
  appendUserMessage: vi.fn(),
  appendAssistantMessage: vi.fn(),
}));

// `@kimiterrace/ai` を **部分 mock**: maskPII だけ差し替え、それ以外 (findUnmaskedPii / buildChatPrompt /
// classifyScope / buildScopeRefusal …) は importActual spread で実物を保持する。
// maskPII の既定挙動は「実 maskPII を呼ぶ」(=正常系)。500 経路のケースのみ mockImplementation で
// 「原文素通し」に差し替える。
vi.mock("@kimiterrace/ai", async (importActual) => {
  const actual = await importActual<typeof import("@kimiterrace/ai")>();
  return {
    ...actual,
    maskPII: vi.fn(actual.maskPII),
  };
});

import { type PiiEntry, maskPII } from "@kimiterrace/ai";
import type { TenantTx } from "@kimiterrace/db";
import {
  type ChatStreamClient,
  type ExecuteChatParams,
  executeChat,
} from "../../lib/student-qa/chat-service";
import {
  appendAssistantMessage,
  appendUserMessage,
  findOrCreateSession,
} from "../../lib/student-qa/persistence";
import { studentQaRateLimiter } from "../../lib/student-qa/rate-limit";

const SCHOOL_ID = "00000000-0000-0000-0000-0000000000aa";
const CLASS_ID = "00000000-0000-0000-0000-0000000000bb";
const MAGIC_LINK_ID = "00000000-0000-0000-0000-0000000000cc";

/**
 * 注入された `req` (モデルへ渡る system/user) と `stream` 呼出回数を覗けるフェイク `ChatStreamClient`。
 * `streamCalls === 0` で「モデルを一切呼んでいない」= 生 PII が Vertex へ渡らない最終防壁を pin する。
 */
function makeModelClient(opts: { chunks?: string[]; fullText?: string }): {
  client: ChatStreamClient;
  state: { req: { system: string; user: string } | null; streamCalls: number };
} {
  const state: {
    req: { system: string; user: string } | null;
    streamCalls: number;
  } = { req: null, streamCalls: 0 };
  const chunks = opts.chunks ?? ["はい"];
  const client: ChatStreamClient = {
    stream(req) {
      state.streamCalls += 1;
      state.req = req;
      return {
        textStream: (async function* () {
          for (const c of chunks) yield c;
        })(),
        done: Promise.resolve({
          fullText: opts.fullText ?? chunks.join(""),
          modelVersion: "gemini-test-001",
          tokenCount: 7,
        }),
      };
    },
  };
  return { client, state };
}

/** `textStream` を消費して `done` まで待つ (永続化を確定させる)。 */
async function drain(result: Awaited<ReturnType<typeof executeChat>>): Promise<void> {
  if (result.kind !== "stream") return;
  for await (const _ of result.textStream) {
    // 消費するだけ
  }
  await result.done;
}

function baseParams(overrides: Partial<ExecuteChatParams> = {}): ExecuteChatParams {
  const { client } = makeModelClient({ chunks: ["はい"] });
  return {
    tx: {} as TenantTx,
    schoolId: SCHOOL_ID,
    identity: {
      kind: "student",
      magicLinkId: MAGIC_LINK_ID,
      classId: CLASS_ID,
      cookieId: "cookie-abc",
    },
    // 学習/進路語を含まない in_scope 質問 (classifyScope を通過させ、fail-closed ブロックまで到達させる)。
    rawQuestion: "山田花子さんの体育祭の出欠は掲示にありますか？",
    piiEntries: [{ value: "山田花子", category: "STUDENT" }],
    contextProvider: vi.fn(async () => [
      { id: "c1", title: "体育祭のお知らせ", body: "6/10 開催。" },
    ]),
    modelClient: client,
    nowMs: 1_000,
    ...overrides,
  };
}

beforeEach(async () => {
  studentQaRateLimiter.reset();
  vi.clearAllMocks();
  // maskPII の既定挙動を「実物」に戻す。`vi.mock` 工場で `vi.fn(actual.maskPII)` を初期実装に
  // しているが、500 ケースは mockImplementation で「原文素通し」に上書きするため、対称性ケースが
  // 実 maskPII を確実に通すよう毎ケース冒頭で実装を再設定する (clearAllMocks は履歴のみ消去で
  // 実装は残るが、ケース順依存を排して明示する)。
  const actual = await vi.importActual<typeof import("@kimiterrace/ai")>("@kimiterrace/ai");
  vi.mocked(maskPII).mockImplementation(actual.maskPII);
  vi.mocked(findOrCreateSession).mockResolvedValue({
    id: "sess-1",
    schoolId: SCHOOL_ID,
    magicLinkId: MAGIC_LINK_ID,
    // 生徒経路のセッションなので user_id は null（#370 XOR）。
    userId: null,
    classId: CLASS_ID,
  });
  vi.mocked(appendUserMessage).mockResolvedValue({ id: "umsg-1" });
  vi.mocked(appendAssistantMessage).mockResolvedValue({ id: "amsg-1" });
});

describe("executeChat: PII マスク漏れ fail-closed (500 pii_leak) の決定的 pin", () => {
  it("maskPII が原文を素通しすると実 findUnmaskedPii が氏名を検出し 500 pii_leak、モデルは呼ばれない", async () => {
    // maskPII を「マスクしたつもりが PII が残る」挙動に差し替える: 入力 text をそのまま masked に返す。
    // 実 findUnmaskedPii (importActual で実物) は piiEntries の "山田花子" が masked に残るのを検出する。
    vi.mocked(maskPII).mockImplementation((text: string) => ({ masked: text, dictionary: {} }));

    const piiEntries: PiiEntry[] = [{ value: "山田花子", category: "STUDENT" }];
    const { client, state } = makeModelClient({ chunks: ["はい"] });
    const result = await executeChat(
      baseParams({
        modelClient: client,
        piiEntries,
        rawQuestion: "山田花子さんの体育祭の出欠は掲示にありますか？",
        contextProvider: vi.fn(async () => [
          { id: "c1", title: "体育祭のお知らせ", body: "6/10 開催。" },
        ]),
      }),
    );

    // 1) fail-closed: 500 pii_leak で拒否される。
    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") return;
    expect(result.status).toBe(500);
    expect(result.reason).toBe("pii_leak");

    // 2) **最終防壁**: モデル (Vertex) は一切呼ばれない (生 PII がモデルへ渡らない)。
    expect(state.streamCalls).toBe(0);
    expect(state.req).toBeNull();

    // 3) 500 経路は session/user/assistant 書込み (chat-service.ts では fail-closed ブロックの後に
    //    findOrCreateSession 以降が来る) より **前** に短絡するため、永続化の副作用もゼロ。
    expect(findOrCreateSession).not.toHaveBeenCalled();
    expect(appendUserMessage).not.toHaveBeenCalled();
    expect(appendAssistantMessage).not.toHaveBeenCalled();
  });

  it("漏れが context 本文のみでも (質問は無害) fail-closed 500 になりモデルを呼ばない", async () => {
    // 質問には PII を含めず、汚染された掲示物本文だけに氏名が残る経路を pin する
    // (executeChat の leak 集合は質問 + 全 context の title/body を走査する)。
    vi.mocked(maskPII).mockImplementation((text: string) => ({ masked: text, dictionary: {} }));

    const piiEntries: PiiEntry[] = [{ value: "佐藤健", category: "STUDENT" }];
    const { client, state } = makeModelClient({ chunks: ["はい"] });
    const result = await executeChat(
      baseParams({
        modelClient: client,
        piiEntries,
        // 質問自体に氏名は無い (in_scope)。
        rawQuestion: "体育祭の集合場所は掲示にありますか？",
        contextProvider: vi.fn(async () => [
          { id: "c1", title: "連絡", body: "佐藤健は本日欠席。" },
        ]),
      }),
    );

    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") return;
    expect(result.status).toBe(500);
    expect(result.reason).toBe("pii_leak");
    expect(state.streamCalls).toBe(0);
    expect(findOrCreateSession).not.toHaveBeenCalled();
    expect(appendAssistantMessage).not.toHaveBeenCalled();
  });

  it("対称性 (非空虚性): 実 maskPII でトークン化されれば leak 無しで通常の stream 経路に進む", async () => {
    // beforeEach で maskPII は実物に戻してある。同じ氏名・同じ質問でも実 maskPII が氏名を
    // {{STUDENT_001}} へトークン化するため findUnmaskedPii は空 → 500 にならず stream へ進む。
    // これにより 500 ケースが「maskPII を壊したからこそ」発火していること (= 実装が正しくマスク
    // できていれば fail-closed は不発) を対比で示し、テストの非空虚性を担保する。
    const piiEntries: PiiEntry[] = [{ value: "山田花子", category: "STUDENT" }];
    const { client, state } = makeModelClient({ chunks: ["はい"] });
    const result = await executeChat(
      baseParams({
        modelClient: client,
        piiEntries,
        rawQuestion: "山田花子さんの体育祭の出欠は掲示にありますか？",
        contextProvider: vi.fn(async () => [
          { id: "c1", title: "体育祭のお知らせ", body: "6/10 開催。" },
        ]),
      }),
    );

    expect(result.kind).toBe("stream");
    if (result.kind !== "stream") return;
    await drain(result);

    // 通常経路に進みモデルが呼ばれ、生氏名は Vertex プロンプトに残らない (実 maskPII の効果)。
    expect(state.streamCalls).toBe(1);
    expect(state.req?.user ?? "").not.toContain("山田花子");
  });
});
