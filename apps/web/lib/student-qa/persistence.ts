import { type TenantTx, aiChatMessages, aiChatSessions } from "@kimiterrace/db";
import { and, desc, eq, isNull, sql } from "drizzle-orm";

/**
 * F06 (#42 第2スライス): 生徒対話の **永続化層**。
 *
 * ai_chat_sessions / ai_chat_messages への INSERT を、**呼び出し側で確立した RLS コンテキスト
 * (`withTenantContext`, ADR-019)** の `TenantTx` 内で行う純粋なドメイン関数群。
 *
 * ## CLAUDE.md 規律
 * - ルール1 (監査列): created_by / updated_by は ai_chat_messages / ai_chat_sessions の auditColumns
 *   で必須化されている。生徒は匿名 (Identity Platform user を持たない) ため `created_by` は null と
 *   する (システム経路、CLAUDE.md ルール1 の「システム作成は null」)。代わりに magic_link_id /
 *   session_id でアクセス元を辿れるため、監査追跡性は保たれる (audit_log は events 経由 #N/A、
 *   本テーブルへの append-only 履歴自体が監査になる)。
 * - ルール2 (RLS): 接続は kimiterrace_app (非 BYPASSRLS)、`app.current_school_id` は呼び出し側が
 *   `withTenantContext` で set 済。本モジュールは `school_id` 条件を**書かない** — RLS に委ねる。
 * - ルール3 (型単一ソース): すべて Drizzle スキーマ (`@kimiterrace/db`) から型を import し、
 *   手書きの interface を作らない。`as any` / `as unknown as` 等のキャストは使わない (型エラーは
 *   根本原因を直す)。`evidence` 列は jsonb (未 `$type` 指定 = `unknown`) なので配列をそのまま渡せる。
 * - ルール4 (PII): `maskedText` には **PII マスキング済テキスト** のみを受け取る。マスキングは
 *   呼び出し側 (chat-service) の責務。本モジュールは契約として「マスク済」を要求し、検証しない
 *   (検証は chat-service が `findUnmaskedPii` で fail-closed する)。
 */

/** assistant メッセージの evidence 1 件 (RAG 引用元の content_version_id 等)。 */
export type ChatEvidenceItem = {
  contentId: string;
  title?: string;
};

/** assistant メッセージ INSERT 用パラメータ。 */
export type AssistantMessageParams = {
  /** 親セッション。caller が確立済の RLS コンテキスト school_id と一致すること。 */
  schoolId: string;
  sessionId: string;
  /** PII マスキング済の本文 (ルール4)。 */
  maskedText: string;
  /** Vertex 応答の model_version (例: "gemini-1.5-pro-002")。監査の追跡性。 */
  modelVersion: string;
  /** RAG 引用元 (空配列なら "[]")。本スライスでは context として渡した content の id 列を入れる。 */
  evidence: readonly ChatEvidenceItem[];
  /** 0.0〜1.0。MVP では grounding 強度 (= context 件数の単調関数) を入れる。 */
  confidenceScore: number;
  /** 概算トークン数 (usage 由来)。集計用。 */
  tokenCount: number;
};

/** user (生徒の質問) メッセージ INSERT 用パラメータ。 */
export type UserMessageParams = {
  schoolId: string;
  sessionId: string;
  /** PII マスキング済の本文 (ルール4)。 */
  maskedText: string;
  tokenCount: number;
};

/** {@link findOrCreateSession} の戻り値。 */
export type ChatSession = {
  id: string;
  schoolId: string;
  magicLinkId: string;
  classId: string;
};

/**
 * 同一 magic_link の active な (closed_at IS NULL) セッションを 1 件返す。無ければ新規作成。
 *
 * 「セッション = 端末/クラスからの連続質問のまとまり」を素朴に表現する: タイムアウトや明示クローズは
 * 別レイヤ (cron / 教員操作) で `closed_at` を立てる。本関数は active 1 件を取り出す入口に徹する。
 */
export async function findOrCreateSession(
  tx: TenantTx,
  params: { schoolId: string; magicLinkId: string; classId: string },
): Promise<ChatSession> {
  const [existing] = await tx
    .select({
      id: aiChatSessions.id,
      schoolId: aiChatSessions.schoolId,
      magicLinkId: aiChatSessions.magicLinkId,
      classId: aiChatSessions.classId,
    })
    .from(aiChatSessions)
    .where(and(eq(aiChatSessions.magicLinkId, params.magicLinkId), isNull(aiChatSessions.closedAt)))
    .orderBy(desc(aiChatSessions.lastMessageAt))
    .limit(1);
  if (existing) {
    return existing;
  }

  const [created] = await tx
    .insert(aiChatSessions)
    .values({
      schoolId: params.schoolId,
      magicLinkId: params.magicLinkId,
      classId: params.classId,
    })
    .returning({
      id: aiChatSessions.id,
      schoolId: aiChatSessions.schoolId,
      magicLinkId: aiChatSessions.magicLinkId,
      classId: aiChatSessions.classId,
    });
  if (!created) {
    throw new Error("ai_chat_sessions の INSERT に失敗しました (returning が空)");
  }
  return created;
}

/**
 * user (生徒) メッセージを ai_chat_messages に追記する。PII マスキング済前提 (ルール4)。
 * 同時に親セッションの message_count をインクリメントし、last_message_at を更新する。
 */
export async function appendUserMessage(
  tx: TenantTx,
  params: UserMessageParams,
): Promise<{ id: string }> {
  const [row] = await tx
    .insert(aiChatMessages)
    .values({
      schoolId: params.schoolId,
      sessionId: params.sessionId,
      role: "user",
      contentText: params.maskedText,
      tokenCount: params.tokenCount,
    })
    .returning({ id: aiChatMessages.id });
  if (!row) {
    throw new Error("ai_chat_messages (user) の INSERT に失敗しました");
  }
  await bumpSession(tx, params.sessionId);
  return row;
}

/**
 * assistant メッセージを ai_chat_messages に追記する。PII マスキング済前提 (ルール4)。
 * confidence_score / evidence / model_version を併せて保管する。
 */
export async function appendAssistantMessage(
  tx: TenantTx,
  params: AssistantMessageParams,
): Promise<{ id: string }> {
  const [row] = await tx
    .insert(aiChatMessages)
    .values({
      schoolId: params.schoolId,
      sessionId: params.sessionId,
      role: "assistant",
      contentText: params.maskedText,
      tokenCount: params.tokenCount,
      modelVersion: params.modelVersion,
      confidenceScore: params.confidenceScore,
      // jsonb 列 (未 `$type` 指定 = `unknown`) なので readonly 配列のコピーをそのまま渡す
      // (ルール3: キャストで型を黙らせない)。
      evidence: [...params.evidence],
    })
    .returning({ id: aiChatMessages.id });
  if (!row) {
    throw new Error("ai_chat_messages (assistant) の INSERT に失敗しました");
  }
  await bumpSession(tx, params.sessionId);
  return row;
}

/** セッションの message_count / last_message_at を 1 件分進める (SQL 内で原子的に増分)。 */
async function bumpSession(tx: TenantTx, sessionId: string): Promise<void> {
  await tx
    .update(aiChatSessions)
    .set({
      messageCount: sql`${aiChatSessions.messageCount} + 1`,
      lastMessageAt: sql`now()`,
    })
    .where(eq(aiChatSessions.id, sessionId));
}
