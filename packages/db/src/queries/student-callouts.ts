import { type InferSelectModel, and, asc, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { TenantTx } from "../client.js";
import { classes } from "../schema/classes.js";
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
 * 並び順は **表示順（`sort_order` 昇順）** を最優先に、同順位は時刻（`scheduled_time` 昇順、未設定は末尾＝
 * NULLS LAST）→ 氏名で決定的に。教員が編集 UI で並べ替えた順を盤面に反映する（保存時に行位置を sort_order に
 * 採番）。旧データ（採番前）は sort_order=0 で揃うため従来どおり時刻→氏名順になる（後方互換、migration 0035）。
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
    .orderBy(
      asc(studentCallouts.sortOrder),
      asc(studentCallouts.scheduledTime),
      asc(studentCallouts.studentName),
    );
}

/** 呼び出し 1 件の書き込み入力（編集 Action が検証・正規化して渡す。空欄は null）。 */
export type StudentCalloutInput = {
  studentName: string;
  location: string | null;
  reason: string | null;
  scheduledTime: string | null;
};

export type ReplaceCalloutsParams = {
  schoolId: string;
  classId: string;
  date: string;
  items: StudentCalloutInput[];
  /** 監査 actor（users.id）。createdBy/updatedBy に入れる。 */
  actorUserId: string;
};

/**
 * 指定クラス・日付の生徒呼び出しを **全置換** する（class_visitors の replaceClassVisitors と同型）。RLS context
 * tx 内で呼ぶこと。手書き WHERE school_id は書かない（tenant_isolation が DELETE/INSERT とも自校に限定・INSERT は
 * WITH CHECK で自校強制）。cross-tenant 防止: 先に対象 class が自校で可視か確認し、不可視なら `null`（呼出側
 * Action が not_found へ）。`schoolId` は actor の自校（= current_school_id）を渡す。
 *
 * @returns 置換後の件数。対象 class が不可視（他校 / 不在）なら `null`。
 */
export async function replaceStudentCallouts(
  tx: TenantTx,
  params: ReplaceCalloutsParams,
): Promise<number | null> {
  const { schoolId, classId, date, items, actorUserId } = params;
  const [cls] = await tx
    .select({ id: classes.id })
    .from(classes)
    .where(eq(classes.id, classId))
    .limit(1);
  if (!cls) {
    return null;
  }
  await tx
    .delete(studentCallouts)
    .where(and(eq(studentCallouts.classId, classId), eq(studentCallouts.calloutDate, date)));
  if (items.length > 0) {
    await tx.insert(studentCallouts).values(
      // 配列の並び順 = 編集 UI の行順。行位置をそのまま sort_order に採番し、表示順を永続化する
      // （getCalloutsForClass が sort_order 昇順で読む）。
      items.map((it, idx) => ({
        schoolId,
        classId,
        calloutDate: date,
        studentName: it.studentName,
        location: it.location,
        reason: it.reason,
        scheduledTime: it.scheduledTime,
        sortOrder: idx,
        createdBy: actorUserId,
        updatedBy: actorUserId,
      })),
    );
  }
  return items.length;
}
