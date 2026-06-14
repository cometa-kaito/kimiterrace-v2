import { redactSuspectedNames } from "@kimiterrace/ai";
import { type TenantTx, aiChatMessages, aiChatSessions, classes, schools } from "@kimiterrace/db";
import type { InferSelectModel } from "drizzle-orm";
import {
  type SQL,
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gte,
  ilike,
  isNotNull,
  isNull,
  lt,
  sql,
} from "drizzle-orm";
import {
  type ListParams,
  dateRangeBounds,
  escapeLike,
  pageWindow,
} from "@/app/_components/datalist/list-params";

/**
 * UIUX-03 PR4: ai_chat 監査ビューア (⚠ PII 最重要) の SELECT 層。
 *
 * 統制は docs/compliance/admin-viewer-policy.md（DRAFT）に従う:
 * - `content_text` は **保存時マスク済み**（ルール4・{{STUDENT_001}} トークン化）。本層は
 *   逆変換（トークン→実名）を一切しない・マスキング辞書に触れない。さらに **表示時に
 *   name-heuristic で残存氏名を伏字化**する多層防御 (`redactContentForDisplay`・ISSUE-1)。
 * - 呼び出し側（ページ）は閲覧のたびに `writeViewAccessAudit` を同一 tx で記録すること。
 * - エクスポートなし（SELECT は画面描画分のみ）。
 *
 * ## 置き場所 / テナント分離
 * `packages/db` 非接触（並行レーン回避、`school-list.ts` 規律）。school_id / role の
 * WHERE は書かない — RLS（tenant_isolation + system_admin_full_access）が可視範囲を決める。
 * WHERE は検索条件のみ（school フィルタは「絞り込み」であってテナント境界ではない）。
 */

type Selectable = Pick<TenantTx, "select">;

type SessionRow = InferSelectModel<typeof aiChatSessions>;
type MessageRow = InferSelectModel<typeof aiChatMessages>;

/** 一覧 1 行（セッション + 校名/クラス名 denormalize、ルール3: 型は schema 由来）。 */
export type AiChatSessionListItem = Pick<
  SessionRow,
  "id" | "schoolId" | "startedAt" | "lastMessageAt" | "messageCount" | "closedAt"
> & {
  schoolName: string;
  className: string | null;
  /** 認証経路（XOR CHECK 由来）: magic_link= 生徒(匿名) / user= 教員。 */
  route: "student" | "teacher";
};

export const AI_CHAT_SORT_COLUMNS = {
  startedAt: aiChatSessions.startedAt,
  lastMessageAt: aiChatSessions.lastMessageAt,
  messageCount: aiChatSessions.messageCount,
  schoolName: schools.name,
} as const;

export const AI_CHAT_SORT_KEYS = Object.keys(AI_CHAT_SORT_COLUMNS) as readonly string[];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** school フィルタの形式検証（uuid 形式のみ通す）。テナント境界ではない（境界は RLS）。 */
export function parseSchoolFilter(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const lower = value.toLowerCase();
  return UUID_RE.test(lower) ? lower : null;
}

/** route フィルタの検証。 */
export function parseRouteFilter(value: string | undefined): "student" | "teacher" | null {
  return value === "student" || value === "teacher" ? value : null;
}

/** status フィルタの検証（active=未クローズ / closed=クローズ済）。 */
export function parseStatusFilter(value: string | undefined): "active" | "closed" | null {
  return value === "active" || value === "closed" ? value : null;
}

export type AiChatSessionPage = { rows: AiChatSessionListItem[]; total: number };

/**
 * 対話セッション一覧（検索 / 経路 / 学校 / 状態 / 開始日範囲 / ソート / ページング）。
 * q は **マスク済み** content_text への EXISTS 部分一致（生 PII には当たらない＝保存時マスクの帰結）。
 */
export async function listAiChatSessionsPage(
  db: Selectable,
  params: ListParams,
): Promise<AiChatSessionPage> {
  const conditions: SQL[] = [];

  if (params.q) {
    const pattern = `%${escapeLike(params.q)}%`;
    conditions.push(
      exists(
        db
          .select({ one: sql`1` })
          .from(aiChatMessages)
          .where(
            and(
              eq(aiChatMessages.sessionId, aiChatSessions.id),
              ilike(aiChatMessages.contentText, pattern),
            ),
          ),
      ),
    );
  }
  const school = parseSchoolFilter(params.filters.school);
  if (school) {
    conditions.push(eq(aiChatSessions.schoolId, school));
  }
  const route = parseRouteFilter(params.filters.route);
  if (route === "student") {
    conditions.push(isNotNull(aiChatSessions.magicLinkId));
  } else if (route === "teacher") {
    conditions.push(isNotNull(aiChatSessions.userId));
  }
  const status = parseStatusFilter(params.filters.status);
  if (status === "active") {
    conditions.push(isNull(aiChatSessions.closedAt));
  } else if (status === "closed") {
    conditions.push(isNotNull(aiChatSessions.closedAt));
  }
  const { since, untilExclusive } = dateRangeBounds(params);
  if (since) {
    conditions.push(gte(aiChatSessions.startedAt, since));
  }
  if (untilExclusive) {
    conditions.push(lt(aiChatSessions.startedAt, untilExclusive));
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const sortColumn =
    AI_CHAT_SORT_COLUMNS[params.sort as keyof typeof AI_CHAT_SORT_COLUMNS] ??
    aiChatSessions.lastMessageAt;
  const orderBy =
    params.dir === "asc"
      ? [asc(sortColumn), asc(aiChatSessions.id)]
      : [desc(sortColumn), asc(aiChatSessions.id)];
  const { limit, offset } = pageWindow(params);

  const [rows, totals] = await Promise.all([
    db
      .select({
        id: aiChatSessions.id,
        schoolId: aiChatSessions.schoolId,
        startedAt: aiChatSessions.startedAt,
        lastMessageAt: aiChatSessions.lastMessageAt,
        messageCount: aiChatSessions.messageCount,
        closedAt: aiChatSessions.closedAt,
        schoolName: schools.name,
        className: classes.name,
        magicLinkId: aiChatSessions.magicLinkId,
      })
      .from(aiChatSessions)
      .innerJoin(schools, eq(aiChatSessions.schoolId, schools.id))
      .leftJoin(classes, eq(aiChatSessions.classId, classes.id))
      .where(where)
      .orderBy(...orderBy)
      .limit(limit)
      .offset(offset),
    db.select({ value: count() }).from(aiChatSessions).where(where),
  ]);

  return {
    rows: rows.map((r) => ({
      id: r.id,
      schoolId: r.schoolId,
      startedAt: r.startedAt,
      lastMessageAt: r.lastMessageAt,
      messageCount: r.messageCount,
      closedAt: r.closedAt,
      schoolName: r.schoolName,
      className: r.className,
      // XOR CHECK (ck_ai_chat_sessions_identity) により magicLinkId 非 null ⇔ 生徒経路。
      route: r.magicLinkId !== null ? "student" : "teacher",
    })),
    total: totals[0]?.value ?? 0,
  };
}

/** 表示用 content_text の追加防御の上限（描画爆発防止）。 */
const CONTENT_DISPLAY_LIMIT = 2000;

/**
 * ISSUE-1 (Opus 検証): content_text は保存時に roster ベース maskPII 済みだが、生徒/保護者は
 * 匿名設計で roster が無く (ADR-003/016)、本文に生で書かれた氏名は確定マスク対象外で残りうる
 * (ADR-030 の Low 残存)。ビューアが PR4 でこれを**新たに verbatim 可視化**するため、表示時に
 * name-heuristic (氏名+ひらがな敬称) で検出した氏名部分を伏字化する多層防御の上積み。
 * 確定マスクではない (漢字敬称/ひらがな名は対象外・ADR-030) ＝**保証ではなく低減**。
 * 既存の {{STUDENT_001}} トークンには触れない (逆変換しない)。
 */
export function redactContentForDisplay(text: string): string {
  const out = redactSuspectedNames(text);
  return out.length > CONTENT_DISPLAY_LIMIT
    ? `${out.slice(0, CONTENT_DISPLAY_LIMIT)}…(全${out.length}文字)`
    : out;
}

/** セッション詳細のメッセージ表示上限（暴走セッションでの描画爆発防止。超過は件数表示）。 */
export const SESSION_MESSAGES_LIMIT = 500;

/** セッション詳細（メタ + メッセージ時系列）。メッセージ本文は保存時マスク済みテキスト。 */
export type AiChatSessionDetail = {
  session: AiChatSessionListItem;
  messages: Pick<
    MessageRow,
    "id" | "role" | "contentText" | "tokenCount" | "modelVersion" | "confidenceScore" | "createdAt"
  >[];
  totalMessages: number;
};

/** 1 セッションの詳細を取得する（無ければ null）。可視範囲は RLS。 */
export async function getAiChatSessionDetail(
  db: Selectable,
  sessionId: string,
): Promise<AiChatSessionDetail | null> {
  if (!UUID_RE.test(sessionId.toLowerCase())) {
    return null;
  }
  const sessionRows = await db
    .select({
      id: aiChatSessions.id,
      schoolId: aiChatSessions.schoolId,
      startedAt: aiChatSessions.startedAt,
      lastMessageAt: aiChatSessions.lastMessageAt,
      messageCount: aiChatSessions.messageCount,
      closedAt: aiChatSessions.closedAt,
      schoolName: schools.name,
      className: classes.name,
      magicLinkId: aiChatSessions.magicLinkId,
    })
    .from(aiChatSessions)
    .innerJoin(schools, eq(aiChatSessions.schoolId, schools.id))
    .leftJoin(classes, eq(aiChatSessions.classId, classes.id))
    .where(eq(aiChatSessions.id, sessionId))
    .limit(1);
  const s = sessionRows[0];
  if (!s) {
    return null;
  }
  const [messages, totals] = await Promise.all([
    db
      .select({
        id: aiChatMessages.id,
        role: aiChatMessages.role,
        contentText: aiChatMessages.contentText,
        tokenCount: aiChatMessages.tokenCount,
        modelVersion: aiChatMessages.modelVersion,
        confidenceScore: aiChatMessages.confidenceScore,
        createdAt: aiChatMessages.createdAt,
      })
      .from(aiChatMessages)
      .where(eq(aiChatMessages.sessionId, sessionId))
      .orderBy(asc(aiChatMessages.createdAt), asc(aiChatMessages.id))
      .limit(SESSION_MESSAGES_LIMIT),
    db
      .select({ value: count() })
      .from(aiChatMessages)
      .where(eq(aiChatMessages.sessionId, sessionId)),
  ]);
  return {
    session: {
      id: s.id,
      schoolId: s.schoolId,
      startedAt: s.startedAt,
      lastMessageAt: s.lastMessageAt,
      messageCount: s.messageCount,
      closedAt: s.closedAt,
      schoolName: s.schoolName,
      className: s.className,
      route: s.magicLinkId !== null ? "student" : "teacher",
    },
    // 表示時の追加 PII 低減 (ADR-030 残存名の伏字。保存データは不変・逆変換しない)。
    messages: messages.map((m) => ({ ...m, contentText: redactContentForDisplay(m.contentText) })),
    totalMessages: totals[0]?.value ?? 0,
  };
}
