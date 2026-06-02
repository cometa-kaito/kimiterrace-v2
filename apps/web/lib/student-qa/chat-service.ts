import {
  type ChatContext,
  type PiiEntry,
  type SupportedLocale,
  buildChatPrompt,
  buildScopeRefusal,
  classifyScope,
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
 *  3. **質問の PII マスキング** (`packages/ai` maskPII、ルール4) — RAG が embedding 化する前に必ずマスク
 *  4. **スコープ分類** (`classifyScope`, ADR-028 §2) — 学習・進路など掲示物外は **embedding/RAG/Gemini を
 *     一切呼ばず** 決定論の多言語拒否文を即返す (コスト 0 / 誘導なし拒否)
 *  5. クラス公開コンテンツの取得 (caller 注入の `ContextProvider`。RAG はマスク済み質問でベクトル検索)
 *  6. **コンテキストの PII マスキング + fail-closed** (ルール4)
 *  7. プロンプト構築 (`buildChatPrompt`, @kimiterrace/ai prompt/chat.ts、ADR-028 補足ガードレール + インジェクション対策込)
 *  8. Vertex AI ストリーミング (caller 注入 `ChatStreamClient`、Vercel AI SDK 想定、ADR-005/006)
 *  9. 永続化: ai_chat_sessions / ai_chat_messages へ **マスク済テキストのみ** 保存 (ルール4)
 *
 * **abstraction の境界**:
 * - `ContextProvider` / `ChatStreamClient` は呼び出し側 (route.ts) で具体実装を注入する。本層は
 *   抽象境界のみに依存することで Vertex / DB 実装なしで決定的にユニットテスト可能 (ADR-012)。
 * - PII の生原文 (`rawQuestion`) は本関数の **内部にのみ** 留まる: マスク済を Vertex / DB へ渡し、
 *   応答もマスク済のまま DB へ保存する (unmask は呼び出し側が表示直前に行う設計、本スライス対象外)。
 */

/**
 * caller が注入する「公開中コンテンツ」プロバイダ。RLS スコープ tx と classId で自校に閉じる。
 * `maskedQuestion` は **マスク済み**（PII 除去後）の質問文で、RAG provider がこれを embedding 化して
 * ベクトル検索する（生 PII を Vertex embedding へ送らないため、chat-service が先にマスクして渡す契約）。
 * MVP 直接取得 provider は `maskedQuestion` を無視し最近の公開掲示物を返す。
 */
export type ContextProvider = (
  tx: TenantTx,
  params: { classId: string; maskedQuestion: string },
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
  /**
   * 拒否文言のロケール (ADR-028 §2、既定 `ja`)。route が Accept-Language 等から `normalizeLocale` で
   * 解決して渡す。out_of_scope 拒否を質問者の言語で返すため (in_scope の回答言語は Gemini が担う)。
   */
  locale?: SupportedLocale;
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
 * Gemini を経由しない **決定論応答** (スコープ外拒否など) を `stream` 結果として返し、
 * user / assistant を通常経路と同じ形で永続化する (会話履歴の連続性 + 監査追跡性、ルール1/4)。
 *
 * Gemini 経路との違いは: 本文が固定文字列 (単一チャンクで stream)、evidence 空、confidence 0、
 * model_version はセンチネル (`scope-refusal:*` 等)。answerText は **既にマスク不要な定型文** で、
 * 生 PII を含まない (拒否文・OUT_OF_SCOPE 等)。
 */
async function streamFixedAnswer(
  tx: TenantTx,
  args: {
    schoolId: string;
    magicLinkId: string;
    classId: string;
    /** 永続化する user メッセージ (マスク済)。 */
    maskedUserText: string;
    /** 固定のアシスタント応答 (拒否文等、生 PII なし)。 */
    answerText: string;
    /** model_version 相当のセンチネル (例 `scope-refusal:study`)。 */
    modelVersion: string;
  },
): Promise<ExecuteChatResult> {
  const session = await findOrCreateSession(tx, {
    schoolId: args.schoolId,
    magicLinkId: args.magicLinkId,
    classId: args.classId,
  });
  await appendUserMessage(tx, {
    schoolId: args.schoolId,
    sessionId: session.id,
    maskedText: args.maskedUserText,
    tokenCount: 0,
  });
  const textStream = (async function* () {
    yield args.answerText;
  })();
  const done: Promise<{ assistantMessageId: string; sessionId: string }> = (async () => {
    const row = await appendAssistantMessage(tx, {
      schoolId: args.schoolId,
      sessionId: session.id,
      maskedText: args.answerText,
      modelVersion: args.modelVersion,
      evidence: [],
      confidenceScore: 0,
      tokenCount: 0,
    });
    return { assistantMessageId: row.id, sessionId: session.id };
  })();
  return { kind: "stream", textStream, done };
}

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
    locale = "ja",
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

  // 3) 質問の PII マスキング (ルール4)。RAG が embedding 化する前に必ずマスクし、生 PII を
  //    Vertex embedding / grounding 検索へ持ち込まない。
  const maskedQuestion = maskPII(validated.question, piiEntries);

  // 4) スコープ分類 (ADR-028 §2: Gemini 呼出前に判定)。学習・進路など掲示物外の質問は
  //    **embedding / RAG / Gemini を一切呼ばず**、決定論の多言語拒否文を即返す
  //    (コスト 0 / レイテンシ 0 / 誘導なし拒否、インジェクション非経由で安全)。
  //    分類はマスク済み質問で行う (PII を再露出しない。キーワード判定はマスクの影響を受けない)。
  const scope = classifyScope(maskedQuestion.masked);
  if (scope.verdict === "out_of_scope") {
    return streamFixedAnswer(tx, {
      schoolId,
      magicLinkId,
      classId,
      maskedUserText: maskedQuestion.masked,
      answerText: buildScopeRefusal(scope, locale),
      // 監査用に拒否理由 (study / career) を model_version 相当のセンチネルへ残す。
      modelVersion: `scope-refusal:${scope.reason}`,
    });
  }

  // 5) クラス公開コンテンツを取得。RAG provider は maskedQuestion をベクトル検索に使う
  //    (MVP 直接取得 provider は無視)。RLS スコープ tx で自校に閉じる。
  const rawContexts = await contextProvider(tx, {
    classId,
    maskedQuestion: maskedQuestion.masked,
  });

  // 6) コンテキスト本体も必ずマスク (ルール4)。
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

  // 7) プロンプト構築 (system/user 役割分離 + XML セパレータ + 中身を data として扱う契約)。
  const prompt = buildChatPrompt({
    question: maskedQuestion.masked,
    contexts: maskedContexts,
  });

  // 8) Vertex SSE 開始。
  const stream = modelClient.stream({ system: prompt.system, user: prompt.user });

  // 9) ストリームを caller (route.ts) に素通しつつ、終了後に永続化を行う:
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
