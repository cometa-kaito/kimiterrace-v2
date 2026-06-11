import { type FeedbackSummary, type TenantTx, feedback } from "@kimiterrace/db";
import { type SQL, and, asc, count, desc, eq, gte, ilike, lt, or } from "drizzle-orm";
import {
  type ListParams,
  dateRangeBounds,
  escapeLike,
  pageWindow,
} from "@/app/admin/_components/datalist/list-params";

/**
 * UIUX-03: フィードバック一覧 (`/admin/system/feedback`) のページング/検索/ソート対応 SELECT 層。
 * `school-list.ts` 踏襲 — `packages/db` (chokepoint) を編集せず `apps/web/lib` に置き、テーブルは
 * barrel から import、型は schema 由来 (`FeedbackSummary`、ルール3)。単一テーブル・JOIN 無しの
 * ため **SQL 側で limit/offset + count** する (全件スキャン廃止)。
 *
 * ## テナント分離 (ルール2 / ADR-019)
 * `feedback` は cross-tenant 系で `system_admin_only` policy が守る。WHERE で role を書かない —
 * 可視範囲は呼出側 (`withSession`) が張る RLS context が決める (system_admin のみ全件、それ以外
 * は 0 件)。本層の WHERE は検索条件のみ。
 *
 * ## PII (ルール4)
 * `student_episode` は PII を含みうる自由記述。本層は表示用 SELECT のみで LLM には渡さない。
 * 検索 (ilike) も DB 内で完結し、外部送信は発生しない。
 */

type Selectable = Pick<TenantTx, "select">;

/** ソート可能列の allowlist。`parseListParams` の sortKeys と ORDER BY を 1 箇所で対応させる。 */
export const FEEDBACK_SORT_COLUMNS = {
  submittedAt: feedback.submittedAt,
  schoolName: feedback.schoolName,
  classroomLabel: feedback.classroomLabel,
  studentReaction: feedback.studentReaction,
  teacherUtility: feedback.teacherUtility,
} as const;

export const FEEDBACK_SORT_KEYS = Object.keys(FEEDBACK_SORT_COLUMNS) as readonly string[];

/** スコアフィルタ (1-5) の妥当値。URL は外部入力のため範囲外は黙って無視する。 */
const SCORE_RE = /^[1-5]$/;

/** 一覧 1 ページ分 + 総件数。 */
export type FeedbackListPage = { rows: FeedbackSummary[]; total: number };

/**
 * フィードバックを検索 (学校名/教室ラベル/エピソード/改善要望の部分一致)・スコアフィルタ
 * (reaction / utility、1-5 完全一致)・受付日範囲・列ソート・ページングで取得する。
 * 同値ソートでも順序が安定するよう id を最終タイブレークに付ける。
 */
export async function listFeedbackPage(
  db: Selectable,
  params: ListParams,
): Promise<FeedbackListPage> {
  const conditions: SQL[] = [];
  if (params.q) {
    const pattern = `%${escapeLike(params.q)}%`;
    const match = or(
      ilike(feedback.schoolName, pattern),
      ilike(feedback.classroomLabel, pattern),
      ilike(feedback.studentEpisode, pattern),
      ilike(feedback.improvement, pattern),
    );
    if (match) {
      conditions.push(match);
    }
  }
  const { since, untilExclusive } = dateRangeBounds(params);
  if (since) {
    conditions.push(gte(feedback.submittedAt, since));
  }
  if (untilExclusive) {
    conditions.push(lt(feedback.submittedAt, untilExclusive));
  }
  const reaction = params.filters.reaction;
  if (reaction !== undefined && SCORE_RE.test(reaction)) {
    conditions.push(eq(feedback.studentReaction, Number(reaction)));
  }
  const utility = params.filters.utility;
  if (utility !== undefined && SCORE_RE.test(utility)) {
    conditions.push(eq(feedback.teacherUtility, Number(utility)));
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const sortColumn =
    FEEDBACK_SORT_COLUMNS[params.sort as keyof typeof FEEDBACK_SORT_COLUMNS] ??
    feedback.submittedAt;
  const orderBy =
    params.dir === "asc"
      ? [asc(sortColumn), asc(feedback.id)]
      : [desc(sortColumn), asc(feedback.id)];
  const { limit, offset } = pageWindow(params);

  const [rows, totals] = await Promise.all([
    db
      .select()
      .from(feedback)
      .where(where)
      .orderBy(...orderBy)
      .limit(limit)
      .offset(offset),
    db.select({ value: count() }).from(feedback).where(where),
  ]);

  return { rows, total: totals[0]?.value ?? 0 };
}
