import { type InferSelectModel, desc, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { KimiterraceDb } from "../client.js";
import { feedback } from "../schema/feedback.js";

/**
 * F12 (#48-M): フィードバックのクエリ層。
 *
 * 2 系統に分かれる (magic-links.ts と同じ構造):
 *   1. **匿名投稿側** (`submitFeedback`): 非認証 (テナント context 無し) で呼ぶ。RLS をくぐる
 *      唯一の扉である SECURITY DEFINER 関数 `submit_feedback` (migration 0010) を呼ぶ。
 *      kimiterrace_app 接続でよく、RLS context は不要。INSERT した行の id のみ返る。
 *   2. **system_admin 閲覧側** (`listFeedback`): system_admin の RLS context を張った接続で呼ぶ。
 *      `system_admin_only` policy により system_admin 以外は 0 件 (cross-tenant 全件は system_admin
 *      のみ)。WHERE で role を書かない — DB レベルの RLS に委ねる (CLAUDE.md ルール2)。
 *
 * 型は schema の `feedback` から派生する (ルール3、手書きドメイン型を作らない)。
 */

/** SELECT だけできれば良い接続 (db / tx の両方を受ける)。 */
type Selectable = Pick<PostgresJsDatabase, "select">;

type FeedbackRow = InferSelectModel<typeof feedback>;

/**
 * system_admin の一覧表示に使う射影 (全フィールド)。`student_episode` は PII を含みうるため
 * (ルール4)、本射影を返すのは system_admin に限定される (RLS が保証)。LLM には渡さない。
 */
export type FeedbackSummary = FeedbackRow;

/** 匿名投稿の入力。studentReaction / teacherUtility は 1-5 (関数 + CHECK で検証)。 */
export type SubmitFeedbackInput = {
  schoolName?: string | null;
  /** 任意参照 (通常 null)。テナント分離キーではない。 */
  schoolId?: string | null;
  classroomLabel?: string | null;
  studentReaction: number;
  teacherUtility: number;
  studentEpisode?: string | null;
  improvement?: string | null;
};

/**
 * 匿名フィードバックを投稿する。SECURITY DEFINER 関数 `submit_feedback` 経由で INSERT する
 * (RLS context 不要)。1-5 範囲外は関数側が例外で倒す (CHECK 制約とも二重防御)。
 *
 * @param db kimiterrace_app ロールの接続 (RLS context は不要)
 * @returns 作成された feedback 行の id
 */
export async function submitFeedback(
  db: Pick<KimiterraceDb, "execute">,
  input: SubmitFeedbackInput,
): Promise<string> {
  const rows = (await db.execute(
    sql`SELECT submit_feedback(
      ${input.schoolName ?? null},
      ${input.schoolId ?? null}::uuid,
      ${input.classroomLabel ?? null},
      ${input.studentReaction},
      ${input.teacherUtility},
      ${input.studentEpisode ?? null},
      ${input.improvement ?? null}
    ) AS id`,
  )) as unknown as Array<{ id: string }>;
  const id = rows[0]?.id;
  if (!id) {
    throw new Error("submitFeedback: submit_feedback が id を返しませんでした");
  }
  return id;
}

/**
 * フィードバックを新しい順に全件返す。可視範囲は RLS が決める (`system_admin_only`)。
 * system_admin 以外の context では 0 件 (cross-tenant 漏洩防止)。
 */
export async function listFeedback(db: Selectable): Promise<FeedbackSummary[]> {
  return db.select().from(feedback).orderBy(desc(feedback.submittedAt), desc(feedback.id));
}
