import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { EDITOR_ROLES } from "@/lib/editor/schedule-core";
import { getClassWeeklyTimetable } from "@/lib/editor/weekly-timetable-queries";
import { tokens } from "@kimiterrace/ui";
import Link from "next/link";
import { notFound } from "next/navigation";
import { WeeklyTimetableEditor } from "../_components/WeeklyTimetableEditor";

/**
 * 週次ベース時間割（F5・セカンド層）。クラスの基本時間割（月〜金）を登録・編集する。クラス編集画面の
 * カレンダー付近から 1 クリックで開く。ここで登録した基本時間割は、日々のエディタで対象日の予定が空のとき
 * 初期値に seed される（コピーオンライト・設計書 §3 F5 / §6.5）。認可は `EDITOR_ROLES`、別テナントは
 * RLS 不可視 → 404。
 */
export default async function ClassTimetablePage({
  params,
}: {
  params: Promise<{ classId: string }>;
}) {
  await requireRole(EDITOR_ROLES);
  const { classId } = await params;

  const data = await withSession(async (tx) => getClassWeeklyTimetable(tx, classId));
  if (!data) {
    notFound();
  }

  return (
    <>
      <nav aria-label="パンくず" style={breadcrumbRowStyle}>
        <Link href={`/app/editor/${classId}`} style={breadcrumbBackStyle}>
          <span aria-hidden="true">‹</span> クラスの編集に戻る
        </Link>
        <span aria-hidden="true" style={breadcrumbSepStyle}>
          ／
        </span>
        <h1 style={titleStyle}>{data.className}・週次ベース時間割</h1>
      </nav>

      <WeeklyTimetableEditor classId={classId} initial={data.timetable} />
    </>
  );
}

const breadcrumbRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.4rem",
  marginBottom: "1rem",
  flexWrap: "wrap",
};
const breadcrumbBackStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.15rem",
  fontSize: tokens.fontSize.xs,
  color: tokens.color.muted,
  textDecoration: "none",
};
const breadcrumbSepStyle: React.CSSProperties = {
  fontSize: tokens.fontSize.xs,
  color: tokens.color.border,
};
const titleStyle: React.CSSProperties = {
  fontSize: tokens.fontSize.sm,
  fontWeight: 600,
  color: tokens.color.neutralFg,
  margin: 0,
};
