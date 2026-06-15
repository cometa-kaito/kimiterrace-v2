import { AssignmentEditor } from "@/app/app/editor/[classId]/_components/AssignmentEditor";
import { ClassEditorShell } from "@/app/app/editor/[classId]/_components/ClassEditorShell";
import { NoticeEditor } from "@/app/app/editor/[classId]/_components/NoticeEditor";
import { ScheduleEditor } from "@/app/app/editor/[classId]/_components/ScheduleEditor";
import { EditorChat } from "@/app/app/editor/_components/EditorChat";
import { isRoleAllowed, requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { getEditorTargetData } from "@/lib/editor/daily-data-read";
import { EDITOR_ROLES, type EditorTarget, isValidDate } from "@/lib/editor/schedule-core";
import { ADS_ROLES } from "@/lib/school-admin/ads-core";
import { QUIET_HOURS_ROLES } from "@/lib/school-admin/quiet-hours-core";
import { tokens } from "@kimiterrace/ui";
import Link from "next/link";
import { notFound } from "next/navigation";

/**
 * scope エディタ (段A-2) の共通ビュー。学校全体 / 学科全体 / 学年全体の各ページが本コンポーネントに
 * `target` を渡して編集する。**クラスエディタと同じタブ shell**（AIで作る / 盤面を編集 / プレビュー・
 * UIUX-02 AI 前面化）に揃え、開いた瞬間は会話型 AI ({@link EditorChat}) が既定タブになる
 * （旧版は AI が FAB に隠れ、scope では前面化が未配線だった。クラス編集と UX を統一）。
 *
 * `EDITOR_ROLES` (teacher / school_admin) に限定。`?date=YYYY-MM-DD` で対象日を指定 (既定は JST 今日)。
 * 対象が自校で不可視 (別テナント / 不在) なら RLS 経由で `getEditorTargetData` が null → 404。
 * 3 セクションを 1 つの `withSession` 内でまとめて読み (RLS tx を共有)、各クライアント編集器に渡す。
 * EditorChat は `scope` 汎用（保存も `setScheduleAction(scope, targetId, …)` 経由）なので scope でも動作。
 */
const JST = "Asia/Tokyo";

/** scope ターゲットのサブページ (ads / quiet-hours) への href。 */
function scopeSubHref(target: EditorTarget, sub: "ads" | "quiet-hours"): string {
  switch (target.scope) {
    case "school":
      return `/app/editor/scope/school/${sub}`;
    case "department":
      return `/app/editor/scope/department/${target.departmentId}/${sub}`;
    case "grade":
      return `/app/editor/scope/grade/${target.gradeId}/${sub}`;
    case "class":
      return `/app/editor/${target.classId}/${sub}`;
  }
}

export async function ScopeEditorView({
  target,
  searchParams,
}: {
  target: EditorTarget;
  searchParams: Promise<{ date?: string }>;
}) {
  const user = await requireRole(EDITOR_ROLES);
  // 広告 / 静粛時間は school_admin / system_admin のみ (ADS_ROLES / QUIET_HOURS_ROLES)。teacher も scope
  // エディタを使うため、死リンク (403 遷移) を出さないよう発行可ロールにだけ導線を出す (class 編集と同規律)。
  const canManageAds = isRoleAllowed(user.role, ADS_ROLES);
  const canManageQuietHours = isRoleAllowed(user.role, QUIET_HOURS_ROLES);
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

  const assistantTargetId =
    target.scope === "department"
      ? target.departmentId
      : target.scope === "grade"
        ? target.gradeId
        : target.scope === "class"
          ? target.classId
          : "school";

  return (
    <>
      <header style={{ marginBottom: "0.75rem" }}>
        <Link
          href="/app/editor"
          style={{ fontSize: tokens.fontSize.xs, color: tokens.color.blueStrong }}
        >
          ← 編集対象の選択へ戻る
        </Link>
        <h1 style={{ fontSize: "1.15rem", margin: "0.15rem 0 0.1rem" }}>{data.label}</h1>
        <p style={mutedStyle}>配下の全クラスに共通表示（クラス個別の入力が優先）。</p>
      </header>

      <ClassEditorShell
        ai={
          <EditorChat
            scope={target.scope}
            targetId={assistantTargetId}
            date={data.date}
            initialDraft={{
              schedules: data.schedule,
              notices: data.notices,
              assignments: data.assignments,
            }}
          />
        }
        board={
          <>
            {canManageAds || canManageQuietHours ? (
              <p style={{ display: "flex", gap: "1rem", flexWrap: "wrap", margin: "0 0 1rem" }}>
                {canManageAds ? (
                  <Link href={scopeSubHref(target, "ads")} style={{ fontSize: "0.9rem" }}>
                    広告管理 →
                  </Link>
                ) : null}
                {canManageQuietHours ? (
                  <Link href={scopeSubHref(target, "quiet-hours")} style={{ fontSize: "0.9rem" }}>
                    静粛時間 →
                  </Link>
                ) : null}
              </p>
            ) : null}
            <div style={{ display: "grid", gap: "1rem" }}>
              <section style={boardCardStyle}>
                <h2 style={boardCardTitleStyle}>予定</h2>
                <ScheduleEditor target={target} date={data.date} initialItems={data.schedule} />
              </section>
              <section style={boardCardStyle}>
                <h2 style={boardCardTitleStyle}>連絡</h2>
                <NoticeEditor target={target} date={data.date} initialItems={data.notices} />
              </section>
              <section style={boardCardStyle}>
                <h2 style={boardCardTitleStyle}>提出物</h2>
                <AssignmentEditor
                  target={target}
                  date={data.date}
                  initialItems={data.assignments}
                />
              </section>
            </div>
          </>
        }
        preview={
          <p style={{ margin: 0, color: tokens.color.muted, fontSize: "0.95rem" }}>
            ここで保存した内容は配下の全クラスのサイネージに共通表示されます
            (クラス個別の入力があれば
            そちらが優先)。実際の表示は各クラスのサイネージ／プレビューでご確認ください。
          </p>
        }
      />
    </>
  );
}

const mutedStyle: React.CSSProperties = {
  color: tokens.color.muted,
  fontSize: tokens.fontSize.xs,
  margin: 0,
};
const boardCardStyle: React.CSSProperties = {
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.lg,
  padding: "1rem 1.25rem",
};
const boardCardTitleStyle: React.CSSProperties = {
  fontSize: "1.05rem",
  margin: "0 0 0.5rem",
};
