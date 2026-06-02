import {
  type ChatContext,
  type PiiEntry,
  buildChatPrompt,
  findUnmaskedPii,
  maskPII,
} from "@kimiterrace/ai";
import type { TenantTx } from "@kimiterrace/db";
import { appendAssistantMessage, appendUserMessage, findOrCreateSession } from "./persistence";
import { type QaRateResult, studentQaRateLimiter } from "./rate-limit";
import { OUT_OF_SCOPE_REPLY, validateQuestion } from "./scope";

/**
 * F06 (#42 第2スライス): 生徒対話の **オーケストレーション層**。
 *
 * SSE route handler から呼ばれる純粋なドメイン関数。以下を 1 リクエスト分で組み立てる:
 *
 *  1. 入力バリデーション (`validateQuestion`, scope.ts)
 *  2. 二重キーレート制限 (`StudentQaRateLimiter`, rate-limit.ts)
 *  3. クラス公開コンテンツの取得 (caller が注入する `ContextProvider`、RAG ベクトルは別 follow-up)
 *  4. **PII マスキング** (`packages/ai` maskPII、CLAUDE.md ルール4)
 *  5. プロンプト構築 (`buildChatPrompt`, @kimiterrace/ai prompt/chat.ts、ADR-028 補足ガードレール + インジェクション対策込)
 *  6. Vertex AI ストリーミング (caller 注入 `ChatStreamClient`、Vercel AI SDK 想定、ADR-005/006)
 *  7. 永続化: ai_chat_sessions / ai_chat_messages へ **マスク済テキストのみ** 保存 (ルール4)
 *
 * **abstraction の境界**:
 * - `ContextProvider` / `ChatStreamClient` は呼び出し側 (route.ts) で具体実装を注入する。本層は
 *   抽象境界のみに依存することで Vertex / DB 実装なしで決定的にユニットテスト可能 (ADR-012)。
 * - PII の生原文 (`rawQuestion`) は本関数の **内部にのみ** 留まる: マスク済を Vertex / DB へ渡し、
 *   応答もマスク済のまま DB へ保存する (unmask は呼び出し側が表示直前に行う設計、本スライス対象外)。
 */

/** caller が注入する「公開中コンテンツ」プロバイダ。RLS スコープ tx と classId で自校に閉じる。 */
export type ContextProvider = (
  tx: TenantTx,
  params: { classId: string },
) => Promise<readonly ChatContext[]>;

/** Vertex SSE ストリームクライアントの抽象境界。Vercel AI SDK `streamText` を想定。 */
export interface ChatStreamClient {
  /**
   * @returns `textStream` はチャンク文字列の async iterable。`done` は全チャンク送出後に解決し、
   *   フル本文と model_version / usage を返す (永続化と監査記録に使用)。
   */
  stream(req: { system: string; user: string }): {
    textStream: AsyncIterable<string>;
    done: Promise<{ fullText: string; modelVersion: string; tokenCount: number }>;
  };
}

/** {@link executeChat} の入力。RLS context (tx) と認証コンテキスト (school/class/magic-link) は caller が確立。 */
export type ExecuteChatParams = {
  tx: TenantTx;
  schoolId: string;
  classId: string;
  magicLinkId: string;
  /** cookie 由来の端末識別子 (レート制限の第二キー)。 */
  cookieId: string;
  /** 生徒が送信した生の質問文 (PII を含みうる)。**本層を出たら全てマスク済**。 */
  rawQuestion: string;
  /** マスキング対象の名簿エントリ (生徒氏名等)。caller が school スコープで解決して渡す。 */
  piiEntries: readonly PiiEntry[];
  contextProvider: ContextProvider;
  modelClient: ChatStreamClient;
  /** テスト決定性のための注入。本番は `Date.now()`。 */
  nowMs?: number;
};

/** {@link executeChat} の戻り値。route.ts が SSE フレームに整形して送出する。 */
export type ExecuteChatResult =
  | {
      kind: "stream";
      /** SSE 化前のチャンク。route.ts が `data: ...\n\n` に包む。 */
      textStream: AsyncIterable<string>;
      /** stream 終了後に解決。永続化済の assistant message id を返す。 */
      done: Promise<{ assistantMessageId: string; sessionId: string }>;
    }
  | { kind: "rejected"; status: number; reason: string; message: string };

/**
 * 生徒の質問 1 件を処理する SSE ハンドラの中核。
 *
 * **副作用**: rate-limit カウンタ消費 + DB 2 行 (user/assistant) INSERT + session 進捗更新。
 * いずれも RLS コンテキスト (caller の `tx`) 内で実行される。
 */
export async function executeChat(params: ExecuteChatParams): Promise<ExecuteChatResult> {
  const {
    tx,
    schoolId,
    classId,
    magicLinkId,
    cookieId,
    rawQuestion,
    piiEntries,
    contextProvider,
    modelClient,
    nowMs = Date.now(),
  } = params;

  // 1) 入力バリデーション。空・長すぎは LLM 前に弾く (コスト/濫用対策)。
  const validated = validateQuestion(rawQuestion);
  if (!validated.ok) {
    return {
      kind: "rejected",
      status: 400,
      reason: validated.reason,
      message:
        validated.reason === "empty" ? "質問が空です。" : "質問が長すぎます (500 文字以内)。",
    };
  }

  // 2) 二重キーレート制限 (per-instance、F06 受け入れ条件)。
  const rl: QaRateResult = studentQaRateLimiter.tryAcquire({
    magicLinkId,
    cookieId,
    nowMs,
  });
  if (!rl.allowed) {
    return {
      kind: "rejected",
      status: 429,
      reason: `rate_limited_${rl.blockedBy}`,
      message: "リクエストが多すぎます。少し時間をおいて再度お試しください。",
    };
  }

  // 3) クラス公開コンテンツを取得 (RAG ベクトルは別 follow-up、直接取得で MVP grounding)。
  const rawContexts = await contextProvider(tx, { classId });

  // 4) PII マスキング (ルール4)。質問本文 + コンテキスト本体の双方を必ずマスク。
  const maskedQuestion = maskPII(validated.question, piiEntries);
  const maskedContexts: ChatContext[] = rawContexts.map((c) => {
    const t = maskPII(c.title, piiEntries);
    const b = maskPII(c.body, piiEntries);
    return { id: c.id, title: t.masked, body: b.masked };
  });
  // fail-closed: マスク漏れがあれば LLM へ送らない (defense-in-depth、ルール4)。
  const leaks = [
    ...findUnmaskedPii(maskedQuestion.masked, piiEntries),
    ...maskedContexts.flatMap((c) => [
      ...findUnmaskedPii(c.title, piiEntries),
      ...findUnmaskedPii(c.body, piiEntries),
    ]),
  ];
  if (leaks.length > 0) {
    return {
      kind: "rejected",
      status: 500,
      reason: "pii_leak",
      message: "内部エラーにより応答できませんでした。",
    };
  }

  // 5) プロンプト構築 (system/user 役割分離 + XML セパレータ + 中身を data として扱う契約)。
  const prompt = buildChatPrompt({
    question: maskedQuestion.masked,
    contexts: maskedContexts,
  });

  // 6) Vertex SSE 開始。
  const stream = modelClient.stream({ system: prompt.system, user: prompt.user });

  // 7) ストリームを caller (route.ts) に素通しつつ、終了後に永続化を行う:
  //    - user メッセージ (マスク済) を 1 行追記
  //    - assistant メッセージ (マスク済) を 1 行追記、evidence/confidence/model_version 含む
  //    永続化失敗は SSE 受信側の表示には影響させない (応答は既に流れている) が、Promise として
  //    route.ts が後続でハンドルできるよう done に詰める。
  const session = await findOrCreateSession(tx, { schoolId, magicLinkId, classId });

  // user メッセージは LLM 呼び出し前に書いておく (応答失敗時もユーザー入力が残る)。
  await appendUserMessage(tx, {
    schoolId,
    sessionId: session.id,
    maskedText: maskedQuestion.masked,
    tokenCount: 0,
  });

  // assistant の本文と usage はストリーム終了後にしか確定しないので、done で順に書く。
  // evidence (引用元) は DB の ai_chat_messages.evidence (jsonb) に保存されるため、**マスク済**
  // の title を載せる (ルール4: DB 保存もマスキング後)。id はサーバ生成の content 識別子で非 PII。
  const evidence = maskedContexts.map((c) => ({ contentId: c.id, title: c.title }));
  const confidenceScore =
    maskedContexts.length === 0 ? 0 : Math.min(0.9, 0.3 + maskedContexts.length * 0.1);

  const done: Promise<{ assistantMessageId: string; sessionId: string }> = (async () => {
    const final = await stream.done;
    // 空ストリーム or 全文が定型拒否でも、契約として 1 行は assistant を残す
    // (会話履歴の連続性 + 監査追跡性のため)。
    const finalText = final.fullText.length > 0 ? final.fullText : OUT_OF_SCOPE_REPLY;
    const row = await appendAssistantMessage(tx, {
      schoolId,
      sessionId: session.id,
      maskedText: finalText,
      modelVersion: final.modelVersion,
      evidence,
      confidenceScore,
      tokenCount: final.tokenCount,
    });
    return { assistantMessageId: row.id, sessionId: session.id };
  })();

  return { kind: "stream", textStream: stream.textStream, done };
}
