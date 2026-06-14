"use server";

import {
  type ClassVisitorInput,
  type TenantTx,
  auditLog,
  replaceClassVisitors,
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
import { validateVisitorItems } from "./visitors-core";

/**
 * パターン2「来校者一覧」編集の Server Action（ADR-008 / schedule-actions と同方針）。指定クラス・日付の
 * 来校者一覧を **全置換** 保存する。
 *
 * 検証 → 認可（`requireRole(EDITOR_ROLES)`、teacher / school_admin）→ `withSession` の自校 RLS tx 内で
 * `replaceClassVisitors`（対象 class 可視確認 → DELETE → INSERT、cross-tenant は RLS が遮断）+ `audit_log`
 * 追記 → `revalidatePath`。対象が自校で不可視（他校 / 不在）なら not_found。手書き WHERE school_id は書かない
 * （RLS 委譲、ルール2）。監査は対象テーブル操作として `audit_log`（tableName="class_visitors"）に残す（ルール1）。
 */
export async function setVisitorsAction(
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
  const v = validateVisitorItems(rawItems);
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
    // 対象クラスが自校で不可視（他校 / 不在）。schedule-actions と同様 invalid に写像する。
    return invalid("編集対象のクラスが見つかりません。");
  }

  revalidatePath(`/app/editor/${classId}`);
  // サイネージ (#48-E1) も即時反映。
  revalidatePath("/app/signage-preview/[classId]", "page");
  return { ok: true, data: { count } };
}

/** RLS tx 内で来校者を全置換し、同一 tx で audit_log を追記する。class 不可視なら null（書込もしない）。 */
async function replaceAndAudit(
  tx: TenantTx,
  actor: EditorActor,
  classId: string,
  date: string,
  items: ClassVisitorInput[],
): Promise<number | null> {
  const count = await replaceClassVisitors(tx, {
    schoolId: actor.schoolId,
    classId,
    date,
    items,
    actorUserId: actor.userId,
  });
  if (count === null) {
    return null;
  }
  // 監査（ルール1）: 来校者氏名そのものは diff に焼かず、対象クラス・日付・件数を残す（PII を監査ログに
  // 蓄積しすぎない。実体は class_visitors 行に残り、RLS + 監査列で追跡可能）。
  await tx.insert(auditLog).values({
    actorUserId: actor.userId,
    schoolId: actor.schoolId,
    tableName: "class_visitors",
    recordId: classId,
    operation: "update",
    diff: { date, count },
    rowHash: "",
    createdBy: actor.userId,
    updatedBy: actor.userId,
  });
  return count;
}
