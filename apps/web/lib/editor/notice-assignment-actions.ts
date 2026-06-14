"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "../auth/guard";
import { withSession } from "../db";
import {
  type DailySectionField,
  EditorTargetNotFoundError,
  isUniqueViolation,
  upsertDailySectionForTarget,
} from "./daily-data-write";
import {
  type AssignmentItem,
  type NoticeItem,
  validateAssignmentItems,
  validateNoticeItems,
} from "./notice-assignment-core";
import {
  type ActionResult,
  EDITOR_ROLES,
  type EditorTarget,
  type Validated,
  conflict,
  forbidden,
  invalid,
  isValidDate,
  parseEditorTarget,
  toEditorActor,
} from "./schedule-core";

/**
 * エディタ Notice / Assignment の Server Action (#48-I、ADR-008 / 段A-2 で scope 汎用化)。指定対象
 * (学校全体 / 学科全体 / 学年全体 / クラス)・日付の連絡 / 提出物を保存する。schedule-actions.ts と
 * 完全に同型 (検証 → 認可 → RLS tx 内 upsert + audit_log、`upsertDailySectionForTarget` 共通コア)。
 *
 * notices / assignments は同一 daily_data 行の別カラムなので、一方の保存は他方を変更しない。
 */

/** 検証 + 認可 + RLS tx 内 upsert を 1 セクション分共通化する内部ヘルパ (scope 汎用)。 */
async function upsertSectionAction<T>(
  scope: unknown,
  targetId: unknown,
  date: unknown,
  validated: Validated<T>,
  field: DailySectionField,
): Promise<ActionResult<{ id: string }>> {
  const target = parseEditorTarget(scope, targetId);
  if (!target) {
    return invalid("編集対象の指定が不正です。");
  }
  if (!isValidDate(date)) {
    return invalid("日付が不正です (YYYY-MM-DD)。");
  }
  if (!validated.ok) {
    return invalid(validated.message);
  }
  const value = validated.value;

  const user = await requireRole(EDITOR_ROLES);
  const actor = toEditorActor(user);
  if (!actor) {
    return forbidden("学校に属さないユーザーは編集できません。");
  }

  try {
    const id = await withSession((tx) =>
      upsertDailySectionForTarget(tx, actor, target, date, field, value),
    );
    revalidatePathsForTarget(target);
    return { ok: true, data: { id } };
  } catch (error) {
    if (error instanceof EditorTargetNotFoundError) {
      return invalid("編集対象が見つかりません。");
    }
    // 並行保存で同一 target+date の INSERT が競合した場合 (ux_daily_data_target_date)。
    if (isUniqueViolation(error)) {
      return conflict("他の操作と競合しました。最新の内容を読み込み直してください。");
    }
    throw error;
  }
}

/** 保存後にエディタ画面とサイネージプレビューを再検証する。scope 別にエディタ path を分岐。 */
function revalidatePathsForTarget(target: EditorTarget): void {
  if (target.scope === "class") {
    revalidatePath(`/app/editor/${target.classId}`);
  } else if (target.scope === "department") {
    revalidatePath(`/app/editor/scope/department/${target.departmentId}`);
  } else if (target.scope === "grade") {
    revalidatePath(`/app/editor/scope/grade/${target.gradeId}`);
  } else {
    revalidatePath("/app/editor/scope/school");
  }
  // サイネージ (#48-E1) も即時反映 (F04 即公開と同思想)。
  revalidatePath("/app/signage-preview/[classId]", "page");
}

/** 指定対象・日付の連絡 (お知らせ) を保存する (scope 汎用)。 */
export async function setNoticesAction(
  scope: unknown,
  targetId: unknown,
  date: unknown,
  rawItems: unknown,
): Promise<ActionResult<{ id: string }>> {
  return upsertSectionAction<NoticeItem[]>(
    scope,
    targetId,
    date,
    validateNoticeItems(rawItems),
    "notices",
  );
}

/** 指定対象・日付の提出物 (課題) を保存する (scope 汎用)。 */
export async function setAssignmentsAction(
  scope: unknown,
  targetId: unknown,
  date: unknown,
  rawItems: unknown,
): Promise<ActionResult<{ id: string }>> {
  return upsertSectionAction<AssignmentItem[]>(
    scope,
    targetId,
    date,
    validateAssignmentItems(rawItems),
    "assignments",
  );
}

/** 指定クラス・日付の連絡 (お知らせ) を保存する (後方互換、class target に委譲)。 */
export async function setClassNoticesAction(
  classId: unknown,
  date: unknown,
  rawItems: unknown,
): Promise<ActionResult<{ id: string }>> {
  return setNoticesAction("class", classId, date, rawItems);
}

/** 指定クラス・日付の提出物 (課題) を保存する (後方互換、class target に委譲)。 */
export async function setClassAssignmentsAction(
  classId: unknown,
  date: unknown,
  rawItems: unknown,
): Promise<ActionResult<{ id: string }>> {
  return setAssignmentsAction("class", classId, date, rawItems);
}
