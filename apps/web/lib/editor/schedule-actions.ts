"use server";

import { type TenantTx, auditLog, classes, dailyData } from "@kimiterrace/db";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireRole } from "../auth/guard";
import { withSession } from "../db";
import {
  type ActionResult,
  EDITOR_ROLES,
  type EditorActor,
  conflict,
  forbidden,
  invalid,
  isUuid,
  isValidDate,
  toEditorActor,
  validateScheduleItems,
} from "./schedule-core";

/**
 * エディタ Schedule の Server Action (#48-H、ADR-008)。指定クラス・日付の時間割を保存する。
 *
 * 検証 → 認可 (`requireRole`) → `withSession` の自校 RLS tx 内で daily_data を upsert + `audit_log`
 * 追記 → `revalidatePath`。class が自校で可視かを RLS 経由で確認してから書き込む (cross-tenant 防止)。
 * 既存行があれば UPDATE (diff に before/after)、無ければ INSERT。
 */

/** クラスが自校で不可視のとき tx をロールバックさせる内部エラー。 */
class ClassNotFoundError extends Error {}

/** PostgreSQL の unique 制約違反 (SQLSTATE 23505)。同一 class+date の並行保存など。 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "23505"
  );
}

async function writeAudit(
  tx: TenantTx,
  actor: EditorActor,
  params: { recordId: string; operation: "insert" | "update"; diff: unknown },
): Promise<void> {
  await tx.insert(auditLog).values({
    actorUserId: actor.userId,
    schoolId: actor.schoolId,
    tableName: "daily_data",
    recordId: params.recordId,
    operation: params.operation,
    diff: params.diff as object,
    // prev_hash / row_hash は BEFORE INSERT トリガ (migration 0003) が計算 (placeholder)。
    rowHash: "",
    createdBy: actor.userId,
    updatedBy: actor.userId,
  });
}

/** 指定クラス・日付の時間割を保存する。 */
export async function setClassScheduleAction(
  classId: unknown,
  date: unknown,
  rawItems: unknown,
): Promise<ActionResult<{ id: string }>> {
  if (!isUuid(classId)) {
    return invalid("クラスの指定が不正です。");
  }
  if (!isValidDate(date)) {
    return invalid("日付が不正です (YYYY-MM-DD)。");
  }
  const v = validateScheduleItems(rawItems);
  if (!v.ok) {
    return invalid(v.message);
  }

  const user = await requireRole(EDITOR_ROLES);
  const actor = toEditorActor(user);
  if (!actor) {
    return forbidden("学校に属さないユーザーは編集できません。");
  }

  try {
    const id = await withSession(async (tx) => {
      // 自校で可視なクラスか (他校 id は RLS で不可視 → not found)。
      const [cls] = await tx
        .select({ id: classes.id })
        .from(classes)
        .where(eq(classes.id, classId))
        .limit(1);
      if (!cls) {
        throw new ClassNotFoundError();
      }

      const [existing] = await tx
        .select({ id: dailyData.id, schedules: dailyData.schedules })
        .from(dailyData)
        .where(
          and(
            eq(dailyData.scope, "class"),
            eq(dailyData.classId, classId),
            eq(dailyData.date, date),
          ),
        )
        .limit(1);

      if (existing) {
        await tx
          .update(dailyData)
          .set({ schedules: v.value, updatedBy: actor.userId, updatedAt: new Date() })
          .where(eq(dailyData.id, existing.id));
        await writeAudit(tx, actor, {
          recordId: existing.id,
          operation: "update",
          diff: { before: { schedules: existing.schedules }, after: { schedules: v.value } },
        });
        return existing.id;
      }

      const [inserted] = await tx
        .insert(dailyData)
        .values({
          schoolId: actor.schoolId,
          scope: "class",
          classId,
          date,
          schedules: v.value,
          createdBy: actor.userId,
          updatedBy: actor.userId,
        })
        .returning({ id: dailyData.id });
      const newId = inserted?.id as string;
      await writeAudit(tx, actor, {
        recordId: newId,
        operation: "insert",
        diff: { after: { schedules: v.value } },
      });
      return newId;
    });

    revalidatePath(`/admin/editor/${classId}`);
    // サイネージ (#48-E1) も即時反映 (F04 即公開と同思想)。
    revalidatePath("/admin/signage-preview/[classId]", "page");
    return { ok: true, data: { id } };
  } catch (error) {
    if (error instanceof ClassNotFoundError) {
      return invalid("クラスが見つかりません。");
    }
    // 並行保存で同一 class+date の INSERT が競合した場合 (ux_daily_data_target_date)。
    if (isUniqueViolation(error)) {
      return conflict("他の操作と競合しました。最新の内容を読み込み直してください。");
    }
    throw error;
  }
}
