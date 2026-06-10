import { type InferSelectModel, and, asc, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { studentCallouts } from "../schema/student-callouts.js";

/**
 * パターン2「生徒呼び出し」の read 層（2026-06-10）。**SELECT のみ**（書き込みは編集 Action 側）。
 *
 * ## テナント分離（ルール2）
 * `school_id` 条件を**書かない** — 呼び出し接続の RLS コンテキスト（`app.current_school_id`、ADR-019）が
 * `student_callouts` の `tenant_isolation` policy で自校行に絞る。サイネージ経路は `getSignageDisplayData` の
 * `withTenantContext({ schoolId })` 内で呼ぶため、結果も自校スコープになる。`class_id` で当該クラスに、
 * `callout_date` で当日（JST 暦日）に絞る。`db` は非 BYPASSRLS 接続（kimiterrace_app）を使うこと。
 *
 * ## 生徒実名（ADR-034）
 * `studentName` はフルネームでサイネージ表示される（ADR-034 の境界下。Vertex には送らない＝本データは payload
 * 直返しのみで LLM/embedding 経路に入れない）。型 `StudentCallout` は schema から `InferSelectModel` 派生（ルール3）。
 */

/** SELECT だけできれば良い（Drizzle db / トランザクションの両方を受ける）。 */
type Selectable = Pick<PostgresJsDatabase, "select">;

/** 生徒呼び出し 1 件（表示用射影）。氏名は必須、他は任意（null）。 */
export type StudentCallout = Pick<
  InferSelectModel<typeof studentCallouts>,
  "id" | "studentName" | "location" | "reason" | "scheduledTime"
>;

/**
 * 指定クラスの指定日（JST 暦日 = `date`）の生徒呼び出し一覧を取得する（RLS で自校スコープ）。
 * 並び順は時刻（`scheduled_time` 昇順、未設定は末尾＝NULLS LAST）→ 氏名で決定的に。
 *
 * @param db      非 BYPASSRLS の Drizzle クライアント / tx（RLS context 下で呼ぶこと）。
 * @param classId 対象クラス。
 * @param date    対象 JST 暦日（YYYY-MM-DD）。サイネージ表示日と同じ値を渡す。
 */
export async function getCalloutsForClass(
  db: Selectable,
  classId: string,
  date: string,
): Promise<StudentCallout[]> {
  return db
    .select({
      id: studentCallouts.id,
      studentName: studentCallouts.studentName,
      location: studentCallouts.location,
      reason: studentCallouts.reason,
      scheduledTime: studentCallouts.scheduledTime,
    })
    .from(studentCallouts)
    .where(and(eq(studentCallouts.classId, classId), eq(studentCallouts.calloutDate, date)))
    .orderBy(asc(studentCallouts.scheduledTime), asc(studentCallouts.studentName));
}
