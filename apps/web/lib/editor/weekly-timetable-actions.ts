"use server";

import { type TenantTx, auditLog, classWeeklySchedules, classes } from "@kimiterrace/db";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireRole } from "../auth/guard";
import { withSession } from "../db";
import { isUniqueViolation } from "./daily-data-write";
import {
  type ActionResult,
  DAILY_DATA_EDITOR_ROLES,
  type ScopedEditorActor,
  conflict,
  forbidden,
  invalid,
  parseEditorTarget,
  toScopedEditorActor,
} from "./schedule-core";
import { validateWeeklyTimetable } from "./weekly-timetable-core";

/**
 * 週次ベース時間割（F5）の保存 Server Action。指定クラスの**基本時間割**（曜日別 `ScheduleItem` 配列）を
 * **1 クラス 1 行**で upsert する（`class_weekly_schedules`・unique(class_id) が衝突キー）。
 *
 * 検証（`validateWeeklyTimetable`＝各曜日を日次予定と同じ検証）→ 認可（`requireRole`）→ 自校 RLS tx
 * （`tenantScoped`）内でクラス可視性確認 → upsert ＋ `audit_log` 追記 → `revalidatePath`。
 * 他校クラスは RLS で不可視（`classes` SELECT が 0 行）→ not_found（cross-tenant 防止・ルール2）。監査は
 * created_by/updated_by = 操作教員（ルール1）。**盤面の表示経路は本テーブルを読まない**（コピーオンライトで
 * `daily_data` のみ表示・設計書 §3 F5）ので、保存してもサイネージは即変化しない（各日を開いて確定した時に反映）。
 *
 * 注: `toScopedEditorActor(user)` を targetSchoolId 無しで呼ぶため **system_admin は常に forbidden**
 * （fail-closed・意図的）。基本時間割は教員の計画操作で /ops 横断経路は不要（copy-day-actions と同判断。
 * 必要になったら setScheduleAction と同様に末尾引数で開ける）。
 */
export async function setClassWeeklyTimetableAction(
  classId: unknown,
  rawByWeekday: unknown,
): Promise<ActionResult<{ id: string }>> {
  const target = parseEditorTarget("class", classId);
  if (!target || target.scope !== "class") {
    return invalid("クラスの指定が不正です。");
  }
  const v = validateWeeklyTimetable(rawByWeekday);
  if (!v.ok) {
    return invalid(v.message);
  }

  const user = await requireRole(DAILY_DATA_EDITOR_ROLES);
  const actor = toScopedEditorActor(user);
  if (!actor) {
    return forbidden(
      user.role === "system_admin"
        ? "対象の学校が指定されていません。"
        : "学校に属さないユーザーは編集できません。",
    );
  }

  try {
    const result = await withSession(
      async (tx) => {
        // クラス可視性（自校か）を RLS 経由で確認。別テナントは不可視 → not_found。
        const [cls] = await tx
          .select({ id: classes.id })
          .from(classes)
          .where(eq(classes.id, target.classId))
          .limit(1);
        if (!cls) {
          return { kind: "not_found" as const };
        }
        // 既存行の有無で insert/update を判定（監査 operation と diff の before を正しく出すため）。
        const [existing] = await tx
          .select({
            id: classWeeklySchedules.id,
            scheduleByWeekday: classWeeklySchedules.scheduleByWeekday,
          })
          .from(classWeeklySchedules)
          .where(eq(classWeeklySchedules.classId, target.classId))
          .limit(1);

        if (existing) {
          await tx
            .update(classWeeklySchedules)
            .set({
              scheduleByWeekday: v.value,
              updatedBy: actor.userRef,
              updatedAt: new Date(),
            })
            .where(eq(classWeeklySchedules.id, existing.id));
          await writeAudit(tx, actor, {
            recordId: existing.id,
            operation: "update",
            diff: { before: existing.scheduleByWeekday, after: v.value },
          });
          return { kind: "ok" as const, id: existing.id };
        }

        const [inserted] = await tx
          .insert(classWeeklySchedules)
          .values({
            schoolId: actor.schoolId,
            classId: target.classId,
            scheduleByWeekday: v.value,
            createdBy: actor.userRef,
            updatedBy: actor.userRef,
          })
          .returning({ id: classWeeklySchedules.id });
        // returning は必ず 1 行（INSERT 成功）。型の T|undefined は非 null 前提で潰す。
        const id = inserted?.id as string;
        await writeAudit(tx, actor, {
          recordId: id,
          operation: "insert",
          diff: { after: v.value },
        });
        return { kind: "ok" as const, id };
      },
      { tenantScoped: true, schoolId: actor.schoolId },
    );

    if (result.kind === "not_found") {
      return invalid("クラスが見つかりません。");
    }
    revalidatePath(`/app/editor/${target.classId}/timetable`);
    // コピーオンライトの seed 元が変わるので、対象クラスのエディタ（未 materialize 日の初期値）も再検証。
    revalidatePath(`/app/editor/${target.classId}`);
    return { ok: true, data: { id: result.id } };
  } catch (error) {
    if (isUniqueViolation(error)) {
      // unique(class_id) の並行 INSERT 競合（1 クラス 1 行）。
      return conflict("他の操作と競合しました。最新の内容を読み込み直してください。");
    }
    throw error;
  }
}

/** class_weekly_schedules 書き込みの監査（ルール1）。daily-data-write の writeAudit と同型・同一 audit_log。 */
async function writeAudit(
  tx: TenantTx,
  actor: ScopedEditorActor,
  params: { recordId: string; operation: "insert" | "update"; diff: unknown },
): Promise<void> {
  await tx.insert(auditLog).values({
    actorUserId: actor.actorUserId,
    actorIdentityUid: actor.identityUid,
    schoolId: actor.schoolId,
    tableName: "class_weekly_schedules",
    recordId: params.recordId,
    operation: params.operation,
    diff: params.diff as object,
    // prev_hash / row_hash は BEFORE INSERT トリガ (migration 0003) が計算（placeholder）。
    rowHash: "",
    createdBy: actor.userRef,
    updatedBy: actor.userRef,
  });
}
