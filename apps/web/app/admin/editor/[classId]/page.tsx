import { isRoleAllowed, requireRole } from "@/lib/auth/guard";
import { PUBLISHER_ROLES } from "@/lib/contents/publish-core";
import { withSession } from "@/lib/db";
import { getClassAssignments, getClassNotices } from "@/lib/editor/notice-assignment-queries";
import { EDITOR_ROLES, isValidDate } from "@/lib/editor/schedule-core";
import { getClassSchedule } from "@/lib/editor/schedule-queries";
import { MAGIC_LINK_ISSUER_ROLES } from "@/lib/magic-link/request";
import { ADS_ROLES } from "@/lib/school-admin/ads-core";
import { QUIET_HOURS_ROLES } from "@/lib/school-admin/quiet-hours-core";
import { TEACHER_INPUT_STAFF_ROLES } from "@/lib/teacher-input/roles";
import { getCalloutsForClass, getVisitorsForClass } from "@kimiterrace/db";
import { tokens } from "@kimiterrace/ui";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EditorAssistant } from "@/app/admin/editor/_components/EditorAssistant";
import { AssignmentEditor } from "./_components/AssignmentEditor";
import { RememberLastClass } from "./_components/RememberLastClass";
import { CalloutsEditor } from "./_components/CalloutsEditor";
import { EditorBoard } from "./_components/EditorBoard";
import { NoticeEditor } from "./_components/NoticeEditor";
import { ScheduleEditor } from "./_components/ScheduleEditor";
import { VisitorsEditor } from "./_components/VisitorsEditor";

/**
 * クラス別エディタ — Schedule (#48-H) + Notice / Assignment (#48-I) セクション。
 *
 * `/admin` 配下 (#48-C layout で認証) + 本ページで `EDITOR_ROLES` (teacher / school_admin) に限定。
 * `?date=YYYY-MM-DD` で対象日を指定 (既定は JST 今日)。別テナントのクラスは RLS 不可視 → 404。
 * 3 セクションを 1 つの `withSession` 内でまとめて読み (RLS tx を共有)、各クライアント編集器に渡す。
 *
 * 段B (2026-06-07): 3 セクションを `EditorBoard`（サイネージ盤面風レイアウト）に並べる。PC は盤面風
 * グリッド、スマホは縦積みフォーム（CSS Module のメディアクエリ）。編集ロジックは各 Editor が担い、
 * 本ページは見出し + 対象解決 + データ取得に徹する。
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
  // 生徒/サイネージ アクセスリンク発行は teacher / school_admin（= 本ページの EDITOR_ROLES と同集合）。
  // 死リンク防止のため発行可ロールのみ導線を出す（magic-link ページは MAGIC_LINK_ISSUER_ROLES で 403 ガード）。
  const canIssueMagicLink = isRoleAllowed(user.role, MAGIC_LINK_ISSUER_ROLES);
  // 教員 nav は「エディタ」1 項目に集約済み（2026-06-11 ユーザー判断）。教員が必要とする AI 系
  // （掲示物 Q&A / 音声・チャット入力と履歴）はクラスエディタ内から辿れるようにする（UIUX-02・隠さない）。
  const canChat = isRoleAllowed(user.role, PUBLISHER_ROLES);
  const canTeacherInput = isRoleAllowed(user.role, TEACHER_INPUT_STAFF_ROLES);
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
    // パターン2「来校者一覧」: 当日のこのクラスの来校者（RLS 自校限定）。pattern1 校では表示に出ないが、
    // エディタは共通（教員/事務が入力。場所/対象者と同じく入力は常時可能）。
    const visitors = await getVisitorsForClass(tx, classId, date);
    // パターン2「生徒呼び出し」: 当日のこのクラスの呼び出し（RLS 自校限定・実名は ADR-034 境界下）。
    const callouts = await getCalloutsForClass(tx, classId, date);
    return { schedule, notices, assignments, visitors, callouts };
  });
  // クラスが自校で不可視 (別テナント / 存在しない) なら schedule が null → 404。
  if (!data || !data.notices || !data.assignments) {
    notFound();
  }
  const { schedule, notices, assignments, visitors, callouts } = data;

  return (
    <>
      <EditorBoard
        header={
          <>
            <header style={{ marginBottom: "1rem" }}>
              {/* ?stay=1: 単一クラス teacher の自動直行（エディタ着地）とのループを防ぎ、選択画面に留まれるようにする。 */}
              <Link
                href="/admin/editor?stay=1"
                style={{ fontSize: "0.85rem", color: tokens.color.blueStrong }}
              >
                ← 編集対象の選択へ戻る
              </Link>
              <h1 style={{ fontSize: "1.4rem", margin: "0.5rem 0 0.25rem" }}>
                {schedule.className}
              </h1>
              {/*
              編集中の内容が「生徒のサイネージに今どう出るか」をその場で確認する導線 (#48-E1 の
              signage-preview への入口)。盤面を見ずに編集する死角を解消する。EDITOR_ROLES ⊂ ADMIN_ROLES
              ゆえ teacher でも 403 にならない (preview は ADMIN_ROLES ガード)。別タブで開き、編集を続けながら
              プレビューを再読込できるようにする。
            */}
              <p style={{ margin: "0 0 0.25rem" }}>
                <Link
                  href={`/admin/signage-preview/${classId}?date=${date}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "0.35rem",
                    fontSize: "0.9rem",
                    fontWeight: 600,
                    color: tokens.color.primaryHover,
                  }}
                >
                  サイネージ表示を確認（別タブ） →
                </Link>
              </p>
              {canManageAds || canManageQuietHours || canIssueMagicLink || canChat ? (
                <p
                  style={{ margin: "0 0 0.25rem", display: "flex", gap: "1rem", flexWrap: "wrap" }}
                >
                  {canIssueMagicLink ? (
                    <Link
                      href={`/admin/editor/${classId}/magic-link`}
                      style={{ fontSize: "0.9rem" }}
                    >
                      サイネージ・生徒リンク →
                    </Link>
                  ) : null}
                  {canManageAds ? (
                    <Link href={`/admin/editor/${classId}/ads`} style={{ fontSize: "0.9rem" }}>
                      広告管理 →
                    </Link>
                  ) : null}
                  {canManageQuietHours ? (
                    <Link
                      href={`/admin/editor/${classId}/quiet-hours`}
                      style={{ fontSize: "0.9rem" }}
                    >
                      静粛時間 →
                    </Link>
                  ) : null}
                  {canChat ? (
                    <Link href="/admin/chat" style={{ fontSize: "0.9rem" }}>
                      掲示物 Q&A →
                    </Link>
                  ) : null}
                  {canTeacherInput ? (
                    <Link href="/admin/teacher-input" style={{ fontSize: "0.9rem" }}>
                      音声/チャット入力・履歴 →
                    </Link>
                  ) : null}
                </p>
              ) : null}
            </header>
            {/* AI おまかせ入口はページを開いた瞬間に見せる（UIUX-02: FAB だけに隠さない）。 */}
            <EditorAssistant
              scope="class"
              targetId={classId}
              date={date}
              existingNotices={notices.items}
              existingSchedules={schedule.items}
              existingAssignments={assignments.items}
              hero
            />
          </>
        }
        schedule={
          <ScheduleEditor
            classId={schedule.classId}
            date={schedule.date}
            initialItems={schedule.items}
          />
        }
        notices={<NoticeEditor classId={classId} date={date} initialItems={notices.items} />}
        assignments={
          <AssignmentEditor classId={classId} date={date} initialItems={assignments.items} />
        }
      />
      <VisitorsEditor classId={classId} date={date} initialItems={visitors} />
      <CalloutsEditor classId={classId} date={date} initialItems={callouts} />
      <RememberLastClass classId={classId} />
    </>
  );
}
