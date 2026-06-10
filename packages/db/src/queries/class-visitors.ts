import { type InferSelectModel, and, asc, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { classVisitors } from "../schema/class-visitors.js";

/**
 * パターン2「来校者一覧」の read 層（F: 来校者・2026-06-10）。**SELECT のみ**（書き込みは編集 Action 側）。
 *
 * ## テナント分離（ルール2）
 * `school_id` 条件を**書かない** — 呼び出し接続の RLS コンテキスト（`app.current_school_id`、ADR-019）が
 * `class_visitors` の `tenant_isolation` policy で自校行に絞る。サイネージ経路は `getSignageDisplayData` の
 * `withTenantContext({ schoolId })` 内で呼ぶため、結果も自校スコープになる。`class_id` で当該クラスに、
 * `visit_date` で当日（JST 暦日）に絞る。`db` は非 BYPASSRLS 接続（kimiterrace_app）を使うこと。
 *
 * ## 型の単一ソース（ルール3）
 * 返却型 `ClassVisitor` は schema の `classVisitors` から `InferSelectModel` で派生する（手書きドメイン型を
 * 作らない）。監査列・schoolId/classId/visitDate（識別子・スコープ）は表示に不要なので射影から除く。
 */

/** SELECT だけできれば良い（Drizzle db / トランザクションの両方を受ける）。 */
type Selectable = Pick<PostgresJsDatabase, "select">;

/** 来校者 1 件（表示用射影）。氏名は必須、他は任意（null）。 */
export type ClassVisitor = Pick<
  InferSelectModel<typeof classVisitors>,
  "id" | "visitorName" | "affiliation" | "scheduledTime" | "purpose" | "host" | "note"
>;

/**
 * 指定クラスの指定日（JST 暦日 = `date`）の来校者一覧を取得する（RLS で自校スコープ）。
 * 並び順は時刻（`scheduled_time` 昇順、未設定は末尾＝NULLS LAST）→ 氏名で決定的に。
 *
 * @param db      非 BYPASSRLS の Drizzle クライアント / tx（RLS context 下で呼ぶこと）。
 * @param classId 対象クラス。
 * @param date    対象 JST 暦日（YYYY-MM-DD）。サイネージ表示日と同じ値を渡す。
 */
export async function getVisitorsForClass(
  db: Selectable,
  classId: string,
  date: string,
): Promise<ClassVisitor[]> {
  return db
    .select({
      id: classVisitors.id,
      visitorName: classVisitors.visitorName,
      affiliation: classVisitors.affiliation,
      scheduledTime: classVisitors.scheduledTime,
      purpose: classVisitors.purpose,
      host: classVisitors.host,
      note: classVisitors.note,
    })
    .from(classVisitors)
    .where(and(eq(classVisitors.classId, classId), eq(classVisitors.visitDate, date)))
    .orderBy(asc(classVisitors.scheduledTime), asc(classVisitors.visitorName));
}
