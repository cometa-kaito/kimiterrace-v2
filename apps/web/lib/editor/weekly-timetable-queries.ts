import { type TenantTx, classWeeklySchedules, classes } from "@kimiterrace/db";
import { eq } from "drizzle-orm";
import { type WeeklyTimetable, validateWeeklyTimetable } from "./weekly-timetable-core";

/**
 * 週次ベース時間割（F5）の読み取り。指定クラスの基本時間割（曜日別 `ScheduleItem` 配列）とクラス名を返す
 * （`getClassSchedule` の `ClassSchedule` と同じくクラス確認と表示名取得を 1 クエリで兼ねる）。
 *
 * **RLS（ルール2）**: `withSession` の自校 tx 内で呼ぶ。`classes` / `class_weekly_schedules` の SELECT は
 * `app.current_school_id` で自校に限定される。別テナントのクラス id は不可視 → `null`（呼び出し側で 404/未表示）。
 * テンプレ未登録（行なし）は空 `{}` を返す。保存済みデータも検証を通して正規化する（壊れた値は空扱い・防御的）。
 */
export type ClassWeeklyTimetable = {
  classId: string;
  className: string;
  timetable: WeeklyTimetable;
};

export async function getClassWeeklyTimetable(
  tx: TenantTx,
  classId: string,
): Promise<ClassWeeklyTimetable | null> {
  // クラス可視性（自校か）を RLS 経由で確認しつつ表示名を取る。別テナントは不可視 → null。
  const [cls] = await tx
    .select({ id: classes.id, name: classes.name })
    .from(classes)
    .where(eq(classes.id, classId))
    .limit(1);
  if (!cls) {
    return null;
  }
  const [row] = await tx
    .select({ raw: classWeeklySchedules.scheduleByWeekday })
    .from(classWeeklySchedules)
    .where(eq(classWeeklySchedules.classId, classId))
    .limit(1);
  if (!row) {
    return { classId, className: cls.name, timetable: {} }; // テンプレ未登録
  }
  const v = validateWeeklyTimetable(row.raw);
  return { classId, className: cls.name, timetable: v.ok ? v.value : {} };
}
