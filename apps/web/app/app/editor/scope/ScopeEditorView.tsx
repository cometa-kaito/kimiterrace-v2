import { AssignmentEditor } from "@/app/app/editor/[classId]/_components/AssignmentEditor";
import { FloatingAiChat } from "@/app/app/editor/[classId]/_components/FloatingAiChat";
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
 * `target` を渡して編集する。**クラスエディタと同じ構成**（盤面/各セクション編集を本画面に、会話型 AI
 * {@link EditorChat} を右下の浮遊チャット {@link FloatingAiChat} に格下げ・タブ shell 廃止 2026-06-16）に揃える。
 * scope には実機盤面プレビューが無いため preview タブ相当の説明テキストは廃止し、3 セクション編集を直接出す
 * （黒画面トグルは class スコープ専用なので scope には足さない）。
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

      {/* 広告 / 静粛時間は school_admin / system_admin の per-scope 管理導線。teacher には出さない（死リンク防止）。 */}
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

      <p style={{ margin: "0 0 1rem", color: tokens.color.muted, fontSize: "0.95rem" }}>
        ここで保存した内容は配下の全クラスのサイネージに共通表示されます（クラス個別の入力があれば
        そちらが優先）。 実際の表示は各クラスのサイネージ／プレビューでご確認ください。
      </p>

      {/* 本画面: 予定 / 連絡 / 提出物の各セクション編集（タブ shell 廃止）。scope には実機盤面プレビューが無いので
          盤面ライブプレビューは出さず、3 セクション編集を直接出す。
          key={data.date}: 対象日変更で各エディタを再マウントし、新日付のデータで state を初期化する。これが無いと
          useState(initial...) が再初期化されず、旧日付の入力が残ったまま保存され「中身が変更先の日付に移る」混線バグに
          なる（class エディタと同根・ユーザー報告 2026-06-16）。 */}
      <div style={{ display: "grid", gap: "1rem" }}>
        <section style={boardCardStyle}>
          <h2 style={boardCardTitleStyle}>予定</h2>
          <ScheduleEditor
            key={data.date}
            target={target}
            date={data.date}
            initialItems={data.schedule}
          />
        </section>
        <section style={boardCardStyle}>
          <h2 style={boardCardTitleStyle}>連絡</h2>
          <NoticeEditor
            key={data.date}
            target={target}
            date={data.date}
            initialItems={data.notices}
          />
        </section>
        <section style={boardCardStyle}>
          <h2 style={boardCardTitleStyle}>提出物</h2>
          <AssignmentEditor
            key={data.date}
            target={target}
            date={data.date}
            initialItems={data.assignments}
          />
        </section>
      </div>

      {/* AI は右下に浮く支援チャット（タブ shell 廃止・class エディタと一貫）。FAB → パネルで開閉。
          key={data.date}: 対象日変更で再マウントし新日付の下書きで初期化（key 無しだと旧日付の入力が残り保存で混線する）。 */}
      <FloatingAiChat>
        <EditorChat
          key={data.date}
          scope={target.scope}
          targetId={assistantTargetId}
          date={data.date}
          initialDraft={{
            schedules: data.schedule,
            notices: data.notices,
            assignments: data.assignments,
          }}
          variant="floating"
        />
      </FloatingAiChat>
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
