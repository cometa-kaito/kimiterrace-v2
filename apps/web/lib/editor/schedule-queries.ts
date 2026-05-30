import { type TenantTx, classes, dailyData } from "@kimiterrace/db";
import { and, asc, desc, eq } from "drizzle-orm";
import { type ScheduleItem, validateScheduleItems } from "./schedule-core";

/** エディタ着地用: 自校のクラス一覧 (新しい年度順)。RLS で自校に限定。 */
export type EditableClass = { id: string; name: string; academicYear: number; grade: number };

export async function getSchoolClasses(tx: TenantTx): Promise<EditableClass[]> {
  return await tx
    .select({
      id: classes.id,
      name: classes.name,
      academicYear: classes.academicYear,
      grade: classes.grade,
    })
    .from(classes)
    .orderBy(desc(classes.academicYear), asc(classes.grade), asc(classes.name));
}

/**
 * エディタ Schedule の読み取り (#48-H)。指定クラス・日付の現在の時間割を取得する。
 *
 * **RLS (ルール2)**: `withSession` の自校 tx 内で呼ぶ。`classes` / `daily_data` の SELECT は
 * `app.current_school_id` で自校に限定される。別テナントのクラス id は不可視 → null。
 */

export type ClassSchedule = {
  classId: string;
  className: string;
  date: string;
  items: ScheduleItem[];
};

export async function getClassSchedule(
  tx: TenantTx,
  classId: string,
  date: string,
): Promise<ClassSchedule | null> {
  const [cls] = await tx
    .select({ id: classes.id, name: classes.name })
    .from(classes)
    .where(eq(classes.id, classId))
    .limit(1);
  if (!cls) {
    return null;
  }

  const [row] = await tx
    .select({ schedules: dailyData.schedules })
    .from(dailyData)
    .where(
      and(eq(dailyData.scope, "class"), eq(dailyData.classId, classId), eq(dailyData.date, date)),
    )
    .limit(1);

  // 保存済みデータも検証を通して typed items に正規化する (旧/壊れたデータは空扱い、防御的)。
  const validated = row ? validateScheduleItems(row.schedules) : null;
  return {
    classId,
    className: cls.name,
    date,
    items: validated?.ok ? validated.value : [],
  };
}
