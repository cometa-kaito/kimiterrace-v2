import { isRoleAllowed, requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { getClassAssignments, getClassNotices } from "@/lib/editor/notice-assignment-queries";
import { EDITOR_ROLES, isValidDate } from "@/lib/editor/schedule-core";
import { getClassSchedule } from "@/lib/editor/schedule-queries";
import { ADS_ROLES } from "@/lib/school-admin/ads-core";
import { QUIET_HOURS_ROLES } from "@/lib/school-admin/quiet-hours-core";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AssignmentEditor } from "./_components/AssignmentEditor";
import { NoticeEditor } from "./_components/NoticeEditor";
import { ScheduleEditor } from "./_components/ScheduleEditor";

/**
 * クラス別エディタ — Schedule (#48-H) + Notice / Assignment (#48-I) セクション。
 *
 * `/admin` 配下 (#48-C layout で認証) + 本ページで `EDITOR_ROLES` (teacher / school_admin) に限定。
 * `?date=YYYY-MM-DD` で対象日を指定 (既定は JST 今日)。別テナントのクラスは RLS 不可視 → 404。
 * 3 セクションを 1 つの `withSession` 内でまとめて読み (RLS tx を共有)、各クライアント編集器に渡す。
 */
const JST = "Asia/Tokyo";

export default async function ClassEditorPage({
  params,
  searchParams,
}: {
  params: Promise<{ classId: string }>;
  searchParams: Promise<{ date?: string }>;
}) {
  const user = await requireRole(EDITOR_ROLES);
  const { classId } = await params;
  // 広告管理 / 静粛時間は school_admin / system_admin 専任 (ads-core / quiet-hours-core)。teacher も
  // このエディタを使うため、teacher には死リンク (403 になる遷移) を出さない (#48-J Low-1 出し分け)。
  const canManageAds = isRoleAllowed(user.role, ADS_ROLES);
  const canManageQuietHours = isRoleAllowed(user.role, QUIET_HOURS_ROLES);
  const { date: dateParam } = await searchParams;
  const date =
    dateParam && isValidDate(dateParam)
      ? dateParam
      : new Date().toLocaleDateString("en-CA", { timeZone: JST });

  const data = await withSession(async (tx) => {
    const schedule = await getClassSchedule(tx, classId, date);
    if (!schedule) {
      return null;
    }
    const notices = await getClassNotices(tx, classId, date);
    const assignments = await getClassAssignments(tx, classId, date);
    return { schedule, notices, assignments };
  });
  // クラスが自校で不可視 (別テナント / 存在しない) なら schedule が null → 404。
  if (!data || !data.notices || !data.assignments) {
    notFound();
  }
  const { schedule, notices, assignments } = data;

  return (
    <div style={{ display: "grid", gap: "2rem" }}>
      <section>
        <Link href="/admin/editor" style={{ fontSize: "0.85rem", color: "#2563eb" }}>
          ← 編集対象の選択へ戻る
        </Link>
        <h1 style={{ fontSize: "1.4rem", margin: "0.5rem 0 0.25rem" }}>{schedule.className}</h1>
        {canManageAds || canManageQuietHours ? (
          <p style={{ margin: "0 0 0.75rem", display: "flex", gap: "1rem" }}>
            {canManageAds ? (
              <Link href={`/admin/editor/${classId}/ads`} style={{ fontSize: "0.9rem" }}>
                広告管理 →
              </Link>
            ) : null}
            {canManageQuietHours ? (
              <Link href={`/admin/editor/${classId}/quiet-hours`} style={{ fontSize: "0.9rem" }}>
                静粛時間 →
              </Link>
            ) : null}
          </p>
        ) : null}
        <h2 style={sectionHeadingStyle}>時間割</h2>
        <ScheduleEditor
          classId={schedule.classId}
          date={schedule.date}
          initialItems={schedule.items}
        />
      </section>

      <section>
        <h2 style={sectionHeadingStyle}>連絡</h2>
        <NoticeEditor classId={classId} date={date} initialItems={notices.items} />
      </section>

      <section>
        <h2 style={sectionHeadingStyle}>提出物</h2>
        <AssignmentEditor classId={classId} date={date} initialItems={assignments.items} />
      </section>
    </div>
  );
}

const sectionHeadingStyle: React.CSSProperties = {
  fontSize: "1.1rem",
  margin: "0 0 0.5rem",
  paddingBottom: "0.25rem",
  borderBottom: "1px solid #e5e7eb",
};
