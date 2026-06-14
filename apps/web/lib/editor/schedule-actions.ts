"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "../auth/guard";
import { withSession } from "../db";
import {
  EditorTargetNotFoundError,
  isUniqueViolation,
  upsertDailySectionForTarget,
} from "./daily-data-write";
import {
  type ActionResult,
  EDITOR_ROLES,
  type EditorTarget,
  conflict,
  forbidden,
  invalid,
  isValidDate,
  parseEditorTarget,
  toEditorActor,
  validateScheduleItems,
} from "./schedule-core";

/**
 * エディタ Schedule の Server Action (#48-H、ADR-008 / 段A-2 で scope 汎用化)。指定対象 (学校全体 /
 * 学科全体 / 学年全体 / クラス)・日付の予定を保存する。
 *
 * 検証 → 認可 (`requireRole`) → `withSession` の自校 RLS tx 内で daily_data を upsert + `audit_log`
 * 追記 (`upsertDailySectionForTarget`) → `revalidatePath`。対象が自校で可視かを RLS 経由で確認してから
 * 書き込む (cross-tenant 防止、ルール2)。既存行があれば UPDATE、無ければ INSERT。
 */

/** 指定対象・日付の予定を保存する (scope 汎用)。 */
export async function setScheduleAction(
  scope: unknown,
  targetId: unknown,
  date: unknown,
  rawItems: unknown,
): Promise<ActionResult<{ id: string }>> {
  const target = parseEditorTarget(scope, targetId);
  if (!target) {
    return invalid("編集対象の指定が不正です。");
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
    const id = await withSession((tx) =>
      upsertDailySectionForTarget(tx, actor, target, date, "schedules", v.value),
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

/**
 * 指定クラス・日付の予定を保存する (後方互換)。既存 `[classId]` 画面・テストのために維持し、
 * scope 汎用版 `setScheduleAction` に class target で委譲する。
 */
export async function setClassScheduleAction(
  classId: unknown,
  date: unknown,
  rawItems: unknown,
): Promise<ActionResult<{ id: string }>> {
  return setScheduleAction("class", classId, date, rawItems);
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
  // サイネージ (#48-E1) も即時反映 (F04 即公開と同思想)。学年/学科/学校編集も配下クラスの
  // 実効データに影響するため、対象 path を再検証する。
  revalidatePath("/app/signage-preview/[classId]", "page");
}
