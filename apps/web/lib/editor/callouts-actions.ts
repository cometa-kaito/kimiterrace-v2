"use server";

import {
  type StudentCalloutInput,
  type TenantTx,
  auditLog,
  replaceStudentCallouts,
} from "@kimiterrace/db";
import { revalidatePath } from "next/cache";
import { requireRole } from "../auth/guard";
import { withSession } from "../db";
import {
  type ActionResult,
  EDITOR_ROLES,
  type EditorActor,
  forbidden,
  invalid,
  isUuid,
  isValidDate,
  toEditorActor,
} from "./schedule-core";
import { validateCalloutItems } from "./callouts-core";

/**
 * パターン2「生徒呼び出し」編集の Server Action（visitors-actions / schedule-actions と同方針）。指定クラス・
 * 日付の呼び出しを **全置換** 保存する。
 *
 * 検証 → 認可（`requireRole(EDITOR_ROLES)`）→ `withSession` の自校 RLS tx 内で `replaceStudentCallouts`
 * （class 可視確認 → DELETE → INSERT、cross-tenant は RLS が遮断）+ `audit_log`（tableName="student_callouts"、
 * **氏名は diff に焼かず** date/件数のみ＝ADR-034 §決定4）→ `revalidatePath`。対象不可視は invalid 写像。
 */
export async function setCalloutsAction(
  classId: unknown,
  date: unknown,
  rawItems: unknown,
): Promise<ActionResult<{ count: number }>> {
  if (!isUuid(classId)) {
    return invalid("クラスの指定が不正です。");
  }
  if (!isValidDate(date)) {
    return invalid("日付が不正です (YYYY-MM-DD)。");
  }
  const v = validateCalloutItems(rawItems);
  if (!v.ok) {
    return invalid(v.message);
  }

  const user = await requireRole(EDITOR_ROLES);
  const actor = toEditorActor(user);
  if (!actor) {
    return forbidden("学校に属さないユーザーは編集できません。");
  }

  const count = await withSession((tx) => replaceAndAudit(tx, actor, classId, date, v.value));
  if (count === null) {
    return invalid("編集対象のクラスが見つかりません。");
  }

  revalidatePath(`/admin/editor/${classId}`);
  revalidatePath("/admin/signage-preview/[classId]", "page");
  return { ok: true, data: { count } };
}

/** RLS tx 内で呼び出しを全置換し、同一 tx で audit_log を追記する。class 不可視なら null（書込もしない）。 */
async function replaceAndAudit(
  tx: TenantTx,
  actor: EditorActor,
  classId: string,
  date: string,
  items: StudentCalloutInput[],
): Promise<number | null> {
  const count = await replaceStudentCallouts(tx, {
    schoolId: actor.schoolId,
    classId,
    date,
    items,
    actorUserId: actor.userId,
  });
  if (count === null) {
    return null;
  }
  // 監査（ルール1 / ADR-034 §決定4）: 生徒氏名は diff に焼かず、対象クラス・日付・件数のみ。
  await tx.insert(auditLog).values({
    actorUserId: actor.userId,
    schoolId: actor.schoolId,
    tableName: "student_callouts",
    recordId: classId,
    operation: "update",
    diff: { date, count },
    rowHash: "",
    createdBy: actor.userId,
    updatedBy: actor.userId,
  });
  return count;
}
