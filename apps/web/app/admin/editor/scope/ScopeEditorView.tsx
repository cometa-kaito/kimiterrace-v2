import { AssignmentEditor } from "@/app/admin/editor/[classId]/_components/AssignmentEditor";
import { EditorBoard } from "@/app/admin/editor/[classId]/_components/EditorBoard";
import { NoticeEditor } from "@/app/admin/editor/[classId]/_components/NoticeEditor";
import { ScheduleEditor } from "@/app/admin/editor/[classId]/_components/ScheduleEditor";
import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { getEditorTargetData } from "@/lib/editor/daily-data-read";
import { EDITOR_ROLES, type EditorTarget, isValidDate } from "@/lib/editor/schedule-core";
import Link from "next/link";
import { notFound } from "next/navigation";

/**
 * scope エディタ (段A-2) の共通ビュー。学校全体 / 学科全体 / 学年全体の各ページが本コンポーネントに
 * `target` を渡して 3 セクション編集器を描画する。`[classId]` ページと同じ構成 (戻るリンク + 見出し +
 * 時間割 / 連絡 / 提出物) を target 汎用にしたもの。
 *
 * `EDITOR_ROLES` (teacher / school_admin) に限定。`?date=YYYY-MM-DD` で対象日を指定 (既定は JST 今日)。
 * 対象が自校で不可視 (別テナント / 不在) なら RLS 経由で `getEditorTargetData` が null → 404。
 * 3 セクションを 1 つの `withSession` 内でまとめて読み (RLS tx を共有)、各クライアント編集器に渡す。
 */
const JST = "Asia/Tokyo";

export async function ScopeEditorView({
  target,
  searchParams,
}: {
  target: EditorTarget;
  searchParams: Promise<{ date?: string }>;
}) {
  await requireRole(EDITOR_ROLES);
  const { date: dateParam } = await searchParams;
  const date =
    dateParam && isValidDate(dateParam)
      ? dateParam
      : new Date().toLocaleDateString("en-CA", { timeZone: JST });

  const data = await withSession((tx) => getEditorTargetData(tx, target, date));
  // 対象が自校で不可視 (別テナント / 存在しない) なら null → 404。
  if (!data) {
    notFound();
  }

  return (
    <EditorBoard
      header={
        <header style={{ marginBottom: "1rem" }}>
          <Link href="/admin/editor" style={{ fontSize: "0.85rem", color: "#2563eb" }}>
            ← 編集対象の選択へ戻る
          </Link>
          <h1 style={{ fontSize: "1.4rem", margin: "0.5rem 0 0.25rem" }}>{data.label}</h1>
          <p style={mutedStyle}>
            この内容は配下の全クラスのサイネージに共通で表示されます
            (クラス個別の入力があればそちらが優先)。
          </p>
        </header>
      }
      schedule={<ScheduleEditor target={target} date={data.date} initialItems={data.schedule} />}
      notices={<NoticeEditor target={target} date={data.date} initialItems={data.notices} />}
      assignments={
        <AssignmentEditor target={target} date={data.date} initialItems={data.assignments} />
      }
    />
  );
}

const mutedStyle: React.CSSProperties = {
  color: "#6b7280",
  fontSize: "0.85rem",
  margin: "0 0 0.5rem",
};
