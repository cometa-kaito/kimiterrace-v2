import { type TenantTx, classes, dailyData } from "@kimiterrace/db";
import { and, eq } from "drizzle-orm";
import {
  type AssignmentItem,
  type NoticeItem,
  validateAssignmentItems,
  validateNoticeItems,
} from "./notice-assignment-core";

/**
 * エディタ Notice / Assignment の読み取り (#48-I)。指定クラス・日付の現在の連絡 / 提出物を取得する。
 * schedule-queries.ts (#48-H) の `getClassSchedule` と同型。
 *
 * **RLS (ルール2)**: `withSession` の自校 tx 内で呼ぶ。`classes` / `daily_data` の SELECT は
 * `app.current_school_id` で自校に限定される。別テナントのクラス id は不可視 → null。
 *
 * 保存済みデータも検証を通して typed items に正規化する (旧 V1 形式や壊れたデータは空扱い、防御的)。
 */

export type ClassNotices = {
  classId: string;
  className: string;
  date: string;
  items: NoticeItem[];
};

export type ClassAssignments = {
  classId: string;
  className: string;
  date: string;
  items: AssignmentItem[];
};

/** クラスが自校で可視か確認しつつ daily_data の対象カラムを取得する内部ヘルパ。 */
async function readDailySection(
  tx: TenantTx,
  classId: string,
  date: string,
  field: "notices" | "assignments",
): Promise<{ className: string; raw: unknown } | null> {
  const [cls] = await tx
    .select({ id: classes.id, name: classes.name })
    .from(classes)
    .where(eq(classes.id, classId))
    .limit(1);
  if (!cls) {
    return null;
  }

  const [row] = await tx
    .select({ [field]: dailyData[field] })
    .from(dailyData)
    .where(
      and(eq(dailyData.scope, "class"), eq(dailyData.classId, classId), eq(dailyData.date, date)),
    )
    .limit(1);

  return { className: cls.name, raw: row ? row[field] : null };
}

export async function getClassNotices(
  tx: TenantTx,
  classId: string,
  date: string,
): Promise<ClassNotices | null> {
  const section = await readDailySection(tx, classId, date, "notices");
  if (!section) {
    return null;
  }
  const validated = section.raw != null ? validateNoticeItems(section.raw) : null;
  return {
    classId,
    className: section.className,
    date,
    items: validated?.ok ? validated.value : [],
  };
}

export async function getClassAssignments(
  tx: TenantTx,
  classId: string,
  date: string,
): Promise<ClassAssignments | null> {
  const section = await readDailySection(tx, classId, date, "assignments");
  if (!section) {
    return null;
  }
  const validated = section.raw != null ? validateAssignmentItems(section.raw) : null;
  return {
    classId,
    className: section.className,
    date,
    items: validated?.ok ? validated.value : [],
  };
}
