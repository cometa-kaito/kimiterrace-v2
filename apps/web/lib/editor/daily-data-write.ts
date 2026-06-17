import { type TenantTx, auditLog, classes, dailyData, departments, grades } from "@kimiterrace/db";
import { and, eq } from "drizzle-orm";
import type { EditorTarget, ScopedEditorActor } from "./schedule-core";
import { targetIdColumns } from "./schedule-core";

/**
 * エディタ daily_data 書き込みの **scope 汎用コア** (段A-2)。schedule / notices / assignments の各
 * セクションを、学校全体 / 学科全体 / 学年全体 / クラスのいずれの scope でも同一ロジックで upsert する。
 *
 * `setClassScheduleAction` (#48-H) / notice-assignment-actions (#48-I) のクラス固定 upsert を一般化し、
 * 重複していた検証後の「対象可視確認 → 既存行 SELECT → INSERT/UPDATE → audit_log」を 1 か所に集約する。
 *
 * **cross-tenant 防止 (ルール2)**: class/grade/department scope は対象 id が**自校で可視か** RLS tx で
 * 確認してから書く (他校の id は `app.current_school_id` で不可視 → not found)。school scope は
 * `actor.schoolId` を直接使う (actor は自校に属する前提)。手書き `WHERE school_id` は書かない。
 *
 * **監査 (ルール1)**: 全書き込みに `audit_log` (tableName="daily_data") を同一 tx で追記する。
 * UPDATE は `updatedAt: new Date()` を明示する ($onUpdate トリガが無いため、ルール「UPDATE で
 * updated_at 明示」)。
 */

/** 対象 (class/grade/department) が自校で不可視のとき tx をロールバックさせる内部エラー。 */
export class EditorTargetNotFoundError extends Error {}

/** PostgreSQL の unique 制約違反 (SQLSTATE 23505)。同一 target+date の並行 INSERT 競合など。 */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "23505"
  );
}

async function writeAudit(
  tx: TenantTx,
  actor: ScopedEditorActor,
  params: { recordId: string; operation: "insert" | "update"; diff: unknown },
): Promise<void> {
  await tx.insert(auditLog).values({
    // 操作者 uid は常に acting uid (tenantScoped 降格後も audit_log_insert policy を満たす)。FK 無し。
    actorUserId: actor.actorUserId,
    // IdP uid キャッシュ。system_admin のみ非 null (users 行が無く actor_user_id を後追いできないため)。
    actorIdentityUid: actor.identityUid,
    schoolId: actor.schoolId,
    tableName: "daily_data",
    recordId: params.recordId,
    operation: params.operation,
    diff: params.diff as object,
    // prev_hash / row_hash は BEFORE INSERT トリガ (migration 0003) が計算 (placeholder)。
    rowHash: "",
    // created_by / updated_by は users.id への FK。system_admin は null (FK 違反 23503 回避)。
    createdBy: actor.userRef,
    updatedBy: actor.userRef,
  });
}

/**
 * 対象が自校で可視か RLS tx で確認する。class/grade/department は対応マスタを SELECT し
 * (他校 id は RLS で不可視 → throw)、school は actor.schoolId が自校なので確認不要。
 */
async function assertTargetVisible(tx: TenantTx, target: EditorTarget): Promise<void> {
  if (target.scope === "school") {
    return;
  }
  if (target.scope === "class") {
    const [row] = await tx
      .select({ id: classes.id })
      .from(classes)
      .where(eq(classes.id, target.classId))
      .limit(1);
    if (!row) {
      throw new EditorTargetNotFoundError();
    }
    return;
  }
  if (target.scope === "grade") {
    const [row] = await tx
      .select({ id: grades.id })
      .from(grades)
      .where(eq(grades.id, target.gradeId))
      .limit(1);
    if (!row) {
      throw new EditorTargetNotFoundError();
    }
    return;
  }
  // department
  const [row] = await tx
    .select({ id: departments.id })
    .from(departments)
    .where(eq(departments.id, target.departmentId))
    .limit(1);
  if (!row) {
    throw new EditorTargetNotFoundError();
  }
}

/** target に対応する daily_data 行を一意に絞る WHERE 句 (scope + 該当 id 列、`ux_daily_data_target_date`)。 */
export function targetMatch(target: EditorTarget, date: string) {
  const cols = targetIdColumns(target);
  switch (target.scope) {
    case "school":
      return and(eq(dailyData.scope, "school"), eq(dailyData.date, date));
    case "department":
      return and(
        eq(dailyData.scope, "department"),
        eq(dailyData.departmentId, cols.departmentId as string),
        eq(dailyData.date, date),
      );
    case "grade":
      return and(
        eq(dailyData.scope, "grade"),
        eq(dailyData.gradeId, cols.gradeId as string),
        eq(dailyData.date, date),
      );
    case "class":
      return and(
        eq(dailyData.scope, "class"),
        eq(dailyData.classId, cols.classId as string),
        eq(dailyData.date, date),
      );
  }
}

/** 書き込み可能な daily_data のセクション列。 */
export type DailySectionField = "schedules" | "notices" | "assignments";

/**
 * 指定 target・日付の 1 セクション (schedules/notices/assignments) を upsert する **tx 内コア**。
 * 呼び出し側 (server action) が `withSession` の自校 RLS tx 内で呼ぶ。可視確認 → 既存行 SELECT →
 * 既存なら当該カラムのみ UPDATE、無ければ INSERT。いずれも audit_log を同一 tx で追記し行 id を返す。
 *
 * notices / assignments は同一 daily_data 行の別カラムなので、一方の保存は他方を変更しない
 * (UPDATE 対象カラムのみ set、INSERT は他カラムをスキーマ default の空配列に任せる)。
 */
export async function upsertDailySectionForTarget(
  tx: TenantTx,
  actor: ScopedEditorActor,
  target: EditorTarget,
  date: string,
  field: DailySectionField,
  value: unknown,
): Promise<string> {
  await assertTargetVisible(tx, target);

  const [existing] = await tx
    .select({ id: dailyData.id, [field]: dailyData[field] })
    .from(dailyData)
    .where(targetMatch(target, date))
    .limit(1);

  if (existing) {
    await tx
      .update(dailyData)
      .set({ [field]: value, updatedBy: actor.userRef, updatedAt: new Date() })
      .where(eq(dailyData.id, existing.id));
    await writeAudit(tx, actor, {
      recordId: existing.id,
      operation: "update",
      diff: { before: { [field]: existing[field] }, after: { [field]: value } },
    });
    return existing.id;
  }

  const cols = targetIdColumns(target);
  const [inserted] = await tx
    .insert(dailyData)
    .values({
      schoolId: actor.schoolId,
      scope: cols.scope,
      gradeId: cols.gradeId,
      departmentId: cols.departmentId,
      classId: cols.classId,
      date,
      [field]: value,
      createdBy: actor.userRef,
      updatedBy: actor.userRef,
    })
    .returning({ id: dailyData.id });
  const newId = inserted?.id as string;
  await writeAudit(tx, actor, {
    recordId: newId,
    operation: "insert",
    diff: { after: { [field]: value } },
  });
  return newId;
}
