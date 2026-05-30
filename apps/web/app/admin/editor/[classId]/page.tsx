import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { EDITOR_ROLES, isValidDate } from "@/lib/editor/schedule-core";
import { getClassSchedule } from "@/lib/editor/schedule-queries";
import { notFound } from "next/navigation";
import { ScheduleEditor } from "./_components/ScheduleEditor";

/**
 * クラス別エディタ — Schedule セクション (#48-H)。
 *
 * `/admin` 配下 (#48-C layout で認証) + 本ページで `EDITOR_ROLES` (teacher / school_admin) に限定。
 * `?date=YYYY-MM-DD` で対象日を指定 (既定は JST 今日)。別テナントのクラスは RLS 不可視 → 404。
 */
const JST = "Asia/Tokyo";

export default async function ClassEditorPage({
  params,
  searchParams,
}: {
  params: Promise<{ classId: string }>;
  searchParams: Promise<{ date?: string }>;
}) {
  await requireRole(EDITOR_ROLES);
  const { classId } = await params;
  const { date: dateParam } = await searchParams;
  const date =
    dateParam && isValidDate(dateParam)
      ? dateParam
      : new Date().toLocaleDateString("en-CA", { timeZone: JST });

  const schedule = await withSession((tx) => getClassSchedule(tx, classId, date));
  if (!schedule) {
    notFound();
  }

  return (
    <div>
      <h1 style={{ fontSize: "1.4rem", marginBottom: "0.25rem" }}>{schedule.className} — 時間割</h1>
      <ScheduleEditor
        classId={schedule.classId}
        date={schedule.date}
        initialItems={schedule.items}
      />
    </div>
  );
}
