import {
  type ChatContext,
  type GroundingMode,
  type PiiEntry,
  type SupportedLocale,
  buildChatPrompt,
  buildScopeRefusal,
  classifyScope,
  findUnmaskedPii,
  maskPII,
} from "@kimiterrace/ai";
import type { TenantTx } from "@kimiterrace/db";
import {
  type ChatSession,
  appendAssistantMessage,
  appendUserMessage,
  findOrCreateSession,
  findOrCreateSessionForUser,
} from "./persistence";
import { type QaRateResult, studentQaRateLimiter, teacherQaRateLimiter } from "./rate-limit";
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
 *  5. クラス公開コンテンツの取得 + grounding モード申告 (caller 注入の `ContextProvider`。RAG はマスク済み
 *     質問でベクトル検索し cosine 類似度 ≥ 0.70 を grounded、満たさなければ general_supplement、ADR-028 §3)
 *  6. **コンテキストの PII マスキング + fail-closed** (ルール4)
 *  7. プロンプト構築 (`buildChatPrompt`, @kimiterrace/ai prompt/chat.ts、grounding モードで system 切替 +
 *     ADR-028 補足ガードレール + インジェクション対策込)
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
 * grounding 結果（ADR-028 §3）。`contexts` に加え `mode` で「掲示準拠（grounded）」か「掲示に根拠なし
 * の一般補足（general_supplement）」かを provider が申告する。`mode` は閾値判定（cosine 類似度 ≥ 0.70）と
 * フォールバックの扱いを知る provider 側でしか決められないため、ここまで伝播させて system プロンプトの
 * 切り替えに使う（{@link buildChatPrompt} の `mode`）。
 */
export type GroundingResult = {
  mode: GroundingMode;
  contexts: readonly ChatContext[];
};

/**
 * caller が注入する「公開中コンテンツ」プロバイダ。RLS スコープ tx で自校に閉じる。
 * `maskedQuestion` は **マスク済み**（PII 除去後）の質問文で、RAG provider がこれを embedding 化して
 * ベクトル検索する（生 PII を Vertex embedding へ送らないため、chat-service が先にマスクして渡す契約）。
 * MVP 直接取得 provider は `maskedQuestion` を無視し最近の公開掲示物を返す。
 * `classId` は生徒経路のクラス（将来のクラス絞り込み #481-2 用、現 provider は未使用）。**教員経路は
 * クラス非バインドのため `null`**。
 *
 * 戻り値は {@link GroundingResult}（mode + contexts）。後方互換のため **素の `ChatContext[]` を返す
 * provider も受け付ける**（{@link normalizeGrounding} が非空なら grounded / 空なら general_supplement に
 * 畳む）。本番経路 provider（{@link createRagContentProvider}）は mode を明示申告する。
 */
export type ContextProvider = (
  tx: TenantTx,
  params: { classId: string | null; maskedQuestion: string },
) => Promise<GroundingResult | readonly ChatContext[]>;

/**
 * provider 戻り値を {@link GroundingResult} に正規化する。素の配列を返すレガシー / テスト provider は、
 * 非空なら掲示準拠とみなし `grounded`、空なら根拠なしとして `general_supplement` に畳む（空配列で grounded
 * を主張させない安全側の既定）。`{mode, contexts}` を返す provider はそのまま使う。
 */
export function normalizeGrounding(
  result: GroundingResult | readonly ChatContext[],
): GroundingResult {
  if (Array.isArray(result)) {
    return { mode: result.length > 0 ? "grounded" : "general_supplement", contexts: result };
  }
  return result as GroundingResult;
}

/**
 * {@link executeChat} の認証アイデンティティ（F06 #370）。`ai_chat_sessions` の identity XOR
 * （magic_link ⊻ user_id, #514）に対応する判別共用体。**1 つのオーケストレーション seam で生徒・教員
 * 両経路を扱う**ことで、敵対的テスト (adversarial.test.ts) の injection/捏造/拒否/テナント分離の保証が
 * 両経路に等しく効く（経路ごとに別関数を作ると教員経路が無防備になる）。
 */
export type StudentChatIdentity = {
  kind: "student";
  /** クラス magic_link セッション id。レート制限の第一キー + セッション解決キー。 */
  magicLinkId: string;
  /** 生徒のクラス（grounding スコープ用、現 provider は未使用 #481-2）。 */
  classId: string;
  /** cookie 由来の端末識別子（レート制限の第二キー）。 */
  cookieId: string;
};
export type TeacherChatIdentity = {
  kind: "teacher";
  /** 認証済み教員の users.id。**route が Identity Platform セッションから導出**して渡す（外部入力不可、
   * confused-deputy 防止 #514 Reviewer）。レート制限キー + セッション解決キー + 監査 created_by。 */
  userId: string;
};
export type ChatIdentity = StudentChatIdentity | TeacherChatIdentity;

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

/** {@link executeChat} の入力。RLS context (tx) と認証コンテキスト (school + identity) は caller が確立。 */
export type ExecuteChatParams = {
  tx: TenantTx;
  schoolId: string;
  /** 認証アイデンティティ（生徒 magic_link ⊻ 教員 user_id, #370）。レート制限・セッション・grounding を分岐。 */
  identity: ChatIdentity;
  /** 生徒/教員が送信した生の質問文 (PII を含みうる)。**本層を出たら全てマスク済**。 */
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
 * identity に応じて active セッションを 1 件解決する（無ければ作成）。生徒は magic_link キー、教員は
 * user_id キー（#370）。レート制限・バリデーションを通過した後にのみ呼ぶ（拒否経路でセッションを作らない）。
 */
function resolveChatSession(
  tx: TenantTx,
  identity: ChatIdentity,
  schoolId: string,
): Promise<ChatSession> {
  if (identity.kind === "teacher") {
    return findOrCreateSessionForUser(tx, { schoolId, userId: identity.userId });
  }
  return findOrCreateSession(tx, {
    schoolId,
    magicLinkId: identity.magicLinkId,
    classId: identity.classId,
  });
}

/**
 * Gemini を経由しない **決定論応答** (スコープ外拒否など) を `stream` 結果として返し、
 * user / assistant を通常経路と同じ形で永続化する (会話履歴の連続性 + 監査追跡性、ルール1/4)。
 *
 * Gemini 経路との違いは: 本文が固定文字列 (単一チャンクで stream)、evidence 空、confidence 0、
 * model_version はセンチネル (`scope-refusal:*` 等)。answerText は **既にマスク不要な定型文** で、
 * 生 PII を含まない (拒否文・OUT_OF_SCOPE 等)。session は caller が {@link resolveChatSession} で
 * 解決済み（生徒/教員で同一フロー）。
 */
async function streamFixedAnswer(
  tx: TenantTx,
  args: {
    schoolId: string;
    session: ChatSession;
    /** 永続化する user メッセージ (マスク済)。 */
    maskedUserText: string;
    /** 固定のアシスタント応答 (拒否文等、生 PII なし)。 */
    answerText: string;
    /** model_version 相当のセンチネル (例 `scope-refusal:study`)。 */
    modelVersion: string;
  },
): Promise<ExecuteChatResult> {
  const session = args.session;
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
 * 生徒・教員の質問 1 件を処理する SSE ハンドラの中核 (#370)。
 *
 * **副作用**: rate-limit カウンタ消費 + DB 2 行 (user/assistant) INSERT + session 進捗更新。
 * いずれも RLS コンテキスト (caller の `tx`) 内で実行される。生徒/教員の違いは `identity` で
 * **レート制限キー (magic_link+cookie ⊻ user_id) とセッション解決 (magic_link ⊻ user_id) のみ**に
 * 局在し、マスキング/分類/RAG/プロンプト/生成/fail-closed は両経路で同一 (敵対的保証も同一)。
 */
export async function executeChat(params: ExecuteChatParams): Promise<ExecuteChatResult> {
  const {
    tx,
    schoolId,
    identity,
    rawQuestion,
    piiEntries,
    contextProvider,
    modelClient,
    locale = "ja",
    nowMs = Date.now(),
  } = params;
  // grounding スコープ用 classId: 生徒は自クラス、教員はクラス非バインドで null。
  const classId = identity.kind === "student" ? identity.classId : null;

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

  // 2) レート制限 (per-instance、F06 受け入れ条件)。生徒=magic_link+cookie 二重キー、
  //    教員=user_id 単一キー (ADR-028)。いずれも超過は何も消費せず 429。
  if (identity.kind === "student") {
    const rl: QaRateResult = studentQaRateLimiter.tryAcquire({
      magicLinkId: identity.magicLinkId,
      cookieId: identity.cookieId,
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
  } else if (!teacherQaRateLimiter.tryAcquire(identity.userId, nowMs)) {
    return {
      kind: "rejected",
      status: 429,
      reason: "rate_limited_user",
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
    // セッションは識別子に応じて解決 (生徒=magic_link / 教員=user_id、#370)。
    const session = await resolveChatSession(tx, identity, schoolId);
    return streamFixedAnswer(tx, {
      schoolId,
      session,
      maskedUserText: maskedQuestion.masked,
      answerText: buildScopeRefusal(scope, locale),
      // 監査用に拒否理由 (study / career) を model_version 相当のセンチネルへ残す。
      modelVersion: `scope-refusal:${scope.reason}`,
    });
  }

  // 5) クラス公開コンテンツを取得。RAG provider は maskedQuestion をベクトル検索に使う
  //    (MVP 直接取得 provider は無視)。RLS スコープ tx で自校に閉じる。
  //    provider は grounding モード (掲示準拠 / 一般補足) も申告する (ADR-028 §3)。
  const grounding = normalizeGrounding(
    await contextProvider(tx, { classId, maskedQuestion: maskedQuestion.masked }),
  );
  const rawContexts = grounding.contexts;

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
  //    grounding モードで system を切り替える (ADR-028 §3): general_supplement は掲示根拠なし時の
  //    ラベル付き一般補足 + 学校固有事実の推測抑止 + 先生誘導を system で強調する。
  const prompt = buildChatPrompt({
    question: maskedQuestion.masked,
    contexts: maskedContexts,
    mode: grounding.mode,
  });

  // 8) Vertex SSE 開始。
  const stream = modelClient.stream({ system: prompt.system, user: prompt.user });

  // 9) ストリームを caller (route.ts) に素通しつつ、終了後に永続化を行う:
  //    - user メッセージ (マスク済) を 1 行追記
  //    - assistant メッセージ (マスク済) を 1 行追記、evidence/confidence/model_version 含む
  //    永続化失敗は SSE 受信側の表示には影響させない (応答は既に流れている) が、Promise として
  //    route.ts が後続でハンドルできるよう done に詰める。
  //    セッションは識別子に応じて解決 (生徒=magic_link / 教員=user_id、#370)。
  const session = await resolveChatSession(tx, identity, schoolId);

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
  // confidence は **掲示準拠 (grounded) のときだけ** 件数で積む。general_supplement は意味的根拠が
  // 検証されていない一般補足ゆえ 0 に倒し、フォールバック文脈で自信を捏造しない (ADR-028 §3 / ルール4)。
  const confidenceScore =
    grounding.mode !== "grounded" || maskedContexts.length === 0
      ? 0
      : Math.min(0.9, 0.3 + maskedContexts.length * 0.1);

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
