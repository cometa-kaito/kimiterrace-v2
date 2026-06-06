import { type TenantTx, classes, dailyData, departments, grades } from "@kimiterrace/db";
import { eq } from "drizzle-orm";
import { targetMatch } from "./daily-data-write";
import {
  type AssignmentItem,
  type NoticeItem,
  validateAssignmentItems,
  validateNoticeItems,
} from "./notice-assignment-core";
import { type EditorTarget, type ScheduleItem, validateScheduleItems } from "./schedule-core";

/**
 * エディタ daily_data 読み取りの **scope 汎用コア** (段A-2)。指定対象 (学校全体 / 学科全体 /
 * 学年全体 / クラス)・日付の現在 3 セクションを 1 行から取得し、表示用ラベルとともに返す。
 * scope ページ (`/admin/editor/scope/...`) が `withSession` の自校 RLS tx 内で呼ぶ。
 *
 * **RLS (ルール2)**: `app.current_school_id` で自校に限定される。対象 id が別テナント / 不在なら
 * `label` 解決が null → 呼び出し側が 404。手書き `WHERE school_id` は書かない。
 *
 * 保存済みデータも検証を通して typed items に正規化する (旧/壊れたデータは空扱い、防御的。
 * schedule-queries / notice-assignment-queries と同思想)。
 */

export type EditorTargetData = {
  /** 見出し用の対象名 (例「学校全体」「◯◯科 全体」「◯◯学年 全体」「1年A組」)。 */
  label: string;
  date: string;
  schedule: ScheduleItem[];
  notices: NoticeItem[];
  assignments: AssignmentItem[];
};

/** 対象の表示名を自校 RLS tx 内で解決する。不可視 (別テナント/不在) なら null。 */
async function resolveTargetLabel(tx: TenantTx, target: EditorTarget): Promise<string | null> {
  switch (target.scope) {
    case "school":
      return "学校全体";
    case "department": {
      const [row] = await tx
        .select({ name: departments.name })
        .from(departments)
        .where(eq(departments.id, target.departmentId))
        .limit(1);
      return row ? `${row.name} 全体` : null;
    }
    case "grade": {
      const [row] = await tx
        .select({ name: grades.name })
        .from(grades)
        .where(eq(grades.id, target.gradeId))
        .limit(1);
      return row ? `${row.name} 全体` : null;
    }
    case "class": {
      const [row] = await tx
        .select({ name: classes.name })
        .from(classes)
        .where(eq(classes.id, target.classId))
        .limit(1);
      return row ? row.name : null;
    }
  }
}

/**
 * 指定 target・日付の現在 3 セクションを取得する。対象が自校で不可視 (別テナント/不在) なら null。
 */
export async function getEditorTargetData(
  tx: TenantTx,
  target: EditorTarget,
  date: string,
): Promise<EditorTargetData | null> {
  const label = await resolveTargetLabel(tx, target);
  if (label === null) {
    return null;
  }

  const [row] = await tx
    .select({
      schedules: dailyData.schedules,
      notices: dailyData.notices,
      assignments: dailyData.assignments,
    })
    .from(dailyData)
    .where(targetMatch(target, date))
    .limit(1);

  const schedule = row ? validateScheduleItems(row.schedules) : null;
  const notices = row ? validateNoticeItems(row.notices) : null;
  const assignments = row ? validateAssignmentItems(row.assignments) : null;

  return {
    label,
    date,
    schedule: schedule?.ok ? schedule.value : [],
    notices: notices?.ok ? notices.value : [],
    assignments: assignments?.ok ? assignments.value : [],
  };
}
