import { type TenantTx, classes, dailyData } from "@kimiterrace/db";
import { and, asc, eq, gte, lt, sql } from "drizzle-orm";
import {
  type AssignmentItem,
  type NoticeItem,
  type PinnedNoticeRow,
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

/**
 * クラス直 (scope=class) の daily_data から、pinned な連絡を含む行を**全期間**で取得する (入力日昇順)。
 *
 * pinned は自然消滅しないため対象日・遡及窓に依存しない (JSONB 包含 `@>`・クラスの行は高々 1 行/日なので
 * 全期間スキャンでも実害なし・設計書 §10)。これが無いと pinned 行は「入力日以外の日のエディタに出てこない
 * 幽霊」になり削除できない (§5.4 の削除経路が生命線)。**RLS (ルール2)**: 自校 tx 内で呼ぶ。クラス不可視
 * (別テナント / 不存在) は空配列 (呼び出し元のページは getClassNotices 側で 404 済みの前提)。
 * 保存済みデータは validate を通し、壊れた行・pinned を含まない行 (偽陽性) は防御的に落とす。
 */
export async function getClassPinnedNoticeRows(
  tx: TenantTx,
  classId: string,
): Promise<PinnedNoticeRow[]> {
  const rows = await tx
    .select({ date: dailyData.date, notices: dailyData.notices })
    .from(dailyData)
    .where(
      and(
        eq(dailyData.scope, "class"),
        eq(dailyData.classId, classId),
        sql`${dailyData.notices} @> '[{"pinned":true}]'::jsonb`,
      ),
    )
    .orderBy(asc(dailyData.date));
  const out: PinnedNoticeRow[] = [];
  for (const row of rows) {
    const validated = validateNoticeItems(row.notices);
    if (validated.ok && validated.value.some((i) => i.pinned === true)) {
      out.push({ date: row.date, items: validated.value });
    }
  }
  return out;
}

/**
 * エディタ WYSIWYG プレビューの「持ち越し」合成用に、**対象日より前**のクラス直の行（連絡 / 提出物つき・
 * 入力日つき）を遡及窓ぶん読む（実盤面の {@link "@/lib/signage/effective-daily-data".EFFECTIVE_LOOKBACK_DAYS}
 * と同じ窓・呼び出し側が渡す）。活性判定・平坦化は純関数
 * {@link "@/lib/signage/effective-daily-data".activeCarryoverItemsOutsideDate} が担う（ここは読むだけ）。
 *
 * **RLS (ルール2)**: withSession の自校 tx 内で呼ぶ（他クエリと同じ）。保存済みデータも検証を通して
 * typed items に正規化（壊れた行は空扱い・防御的）。両セクションとも空の行は落とす（無駄な転送をしない）。
 */
export async function getClassCarryoverDailyRows(
  tx: TenantTx,
  classId: string,
  date: string,
  windowStart: string,
): Promise<{ date: string; notices: NoticeItem[]; assignments: AssignmentItem[] }[]> {
  const rows = await tx
    .select({
      date: dailyData.date,
      notices: dailyData.notices,
      assignments: dailyData.assignments,
    })
    .from(dailyData)
    .where(
      and(
        eq(dailyData.scope, "class"),
        eq(dailyData.classId, classId),
        gte(dailyData.date, windowStart),
        lt(dailyData.date, date),
      ),
    )
    .orderBy(asc(dailyData.date));
  const out: { date: string; notices: NoticeItem[]; assignments: AssignmentItem[] }[] = [];
  for (const row of rows) {
    const notices = row.notices != null ? validateNoticeItems(row.notices) : null;
    const assignments = row.assignments != null ? validateAssignmentItems(row.assignments) : null;
    const noticeItems = notices?.ok ? notices.value : [];
    const assignmentItems = assignments?.ok ? assignments.value : [];
    if (noticeItems.length > 0 || assignmentItems.length > 0) {
      out.push({ date: row.date, notices: noticeItems, assignments: assignmentItems });
    }
  }
  return out;
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
