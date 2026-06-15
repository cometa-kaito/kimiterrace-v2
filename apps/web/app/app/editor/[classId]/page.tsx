import { EditorChat } from "@/app/app/editor/_components/EditorChat";
import { isRoleAllowed, requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { getClassAssignments, getClassNotices } from "@/lib/editor/notice-assignment-queries";
import { EDITOR_ROLES, isValidDate } from "@/lib/editor/schedule-core";
import { getClassSchedule } from "@/lib/editor/schedule-queries";
import { ADS_ROLES } from "@/lib/school-admin/ads-core";
import { QUIET_HOURS_ROLES } from "@/lib/school-admin/quiet-hours-core";
import { SignageBoard } from "@/app/app/signage-preview/[classId]/_components/SignageBoard";
import { getClassSignageBlackout } from "@/lib/signage/blackout";
import { getEffectiveDailyData } from "@/lib/signage/effective-daily-data";
import { patternIncludesBlock } from "@/lib/signage/pattern-blocks";
import { getSignageDesignPattern } from "@/lib/signage/signage-design";
import { getCalloutsForClass, getEffectiveAdsForClass, getVisitorsForClass } from "@kimiterrace/db";
import { tokens } from "@kimiterrace/ui";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AssignmentEditor } from "./_components/AssignmentEditor";
import { BlackoutToggle } from "./_components/BlackoutToggle";
import { CalloutsEditor } from "./_components/CalloutsEditor";
import { ClassEditorShell } from "./_components/ClassEditorShell";
import { NoticeEditor } from "./_components/NoticeEditor";
import { RememberLastClass } from "./_components/RememberLastClass";
import { ScheduleEditor } from "./_components/ScheduleEditor";
import { VisitorsEditor } from "./_components/VisitorsEditor";
import boardLayout from "./_components/board-layout.module.css";

/**
 * クラス別エディタ — 会話型 AI への作り直し（finding 2b・学校体験リニューアル 2026-06-13）。
 *
 * `/app` 配下 (#48-C layout で認証) + 本ページで `EDITOR_ROLES` (teacher / school_admin) に限定。
 * `?date=YYYY-MM-DD` で対象日（既定は JST 今日）。別テナントのクラスは RLS 不可視 → 404。
 *
 * **タブ shell（{@link ClassEditorShell}）**: 「AIで作る（会話型 {@link EditorChat}）/ 盤面を編集 /
 * プレビュー」。開いた瞬間は **AI タブが既定**（話して作るを主役に）。旧ポップオーバー Assistant と
 * 表紙の 4 リンク（サイネージ確認 / 生徒リンク / 掲示物Q&A / 音声入力）は撤去（ユーザー判断 2026-06-13）:
 * サイネージ確認は**プレビュータブ**へ、生徒リンク発行は**管理者面へ移管**、掲示物Q&A・音声入力は
 * **会話型 AI に内包**。`広告管理` / `静粛時間` は school_admin の per-class 管理導線として「盤面を編集」
 * タブに残す（teacher には出さない＝死リンク防止）。
 *
 * 反映の取りこぼし防止: 会話の下書きを**現在の盤面でシード**する（per-section save は置換のため、AI が
 * 触れなかったセクションも全体像として保持してから反映する）。許可セクション（pattern 準拠）の解決と
 * 盤面プレビュー内蔵は AI レーン meta + その他レーン pattern 単一ソースで段階的に効く。
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
  // 広告管理 / 静粛時間は school_admin / system_admin 専任。teacher には出さない（死リンク防止）。
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
    // サイネージデザインパターンを解決（学校レベル既定）。来校者一覧 / 生徒呼び出しは `PATTERN_BLOCKS`
    // 上 pattern2 専用ブロックなので、パターンに含まれる時だけ取得・描画する（pattern1 では取得もしない＝
    // 不要セクションの無条件描画を解消・指摘ログ finding①。単一ソース `patternIncludesBlock` で駆動し
    // `=== "pattern2"` のハードコード分岐を作らない＝将来パターン追加に自動追従）。
    const pattern = await getSignageDesignPattern(tx);
    const showVisitors = patternIncludesBlock(pattern, "visitor");
    const showCallouts = patternIncludesBlock(pattern, "callout");
    const visitors = showVisitors ? await getVisitorsForClass(tx, classId, date) : null;
    const callouts = showCallouts ? await getCalloutsForClass(tx, classId, date) : null;
    // プレビュータブ用: 教室のサイネージに実際どう出るか（class>grade>dept>school のマージ結果 + 実効広告）。
    const previewDaily = await getEffectiveDailyData(tx, classId, date);
    const previewAds = await getEffectiveAdsForClass(tx, classId);
    // プレビュータブの黒画面トグル初期値（class スコープ display_settings.blackout）。同一 tx・RLS 自校限定。
    const blackout = await getClassSignageBlackout(tx, classId);
    return {
      schedule,
      notices,
      assignments,
      showVisitors,
      showCallouts,
      visitors,
      callouts,
      previewDaily,
      previewAds,
      blackout,
    };
  });
  // クラスが自校で不可視 (別テナント / 存在しない) なら schedule が null → 404。
  if (!data || !data.notices || !data.assignments) {
    notFound();
  }
  const {
    schedule,
    notices,
    assignments,
    showVisitors,
    showCallouts,
    visitors,
    callouts,
    previewDaily,
    previewAds,
    blackout,
  } = data;

  return (
    <>
      {/* 画面付随物（戻る + クラス名）は小さく薄いパンくずに格下げ＝主役（タブ以下の編集面）に視線が
          向くようにする（ユーザー指摘 2026-06-15）。クラス名は h1 を保ち見出し階層は崩さず、視覚的にのみ
          控えめにする。?stay=1 は単一クラス teacher の自動直行（着地）とのループ防止。 */}
      <nav aria-label="パンくず" style={breadcrumbRowStyle}>
        <Link href="/app/editor?stay=1" style={breadcrumbBackStyle}>
          <span aria-hidden="true">‹</span> 戻る
        </Link>
        <span aria-hidden="true" style={breadcrumbSepStyle}>
          ／
        </span>
        <h1 style={classTitleStyle}>{schedule.className}</h1>
      </nav>

      <ClassEditorShell
        ai={
          <EditorChat
            scope="class"
            targetId={classId}
            date={date}
            initialDraft={{
              schedules: schedule.items,
              notices: notices.items,
              assignments: assignments.items,
            }}
          />
        }
        board={
          <>
            {canManageAds || canManageQuietHours ? (
              <p style={{ display: "flex", gap: "1rem", flexWrap: "wrap", margin: "0 0 1rem" }}>
                {canManageAds ? (
                  <Link href={`/app/editor/${classId}/ads`} style={{ fontSize: "0.9rem" }}>
                    広告管理 →
                  </Link>
                ) : null}
                {canManageQuietHours ? (
                  <Link href={`/app/editor/${classId}/quiet-hours`} style={{ fontSize: "0.9rem" }}>
                    静粛時間 →
                  </Link>
                ) : null}
              </p>
            ) : null}
            {/* 盤面を編集タブ: 予定（時限×科目…と横に広い表）は全幅、連絡/提出物は広い画面でのみ 2 カラム
                （board-layout.module.css。十分広い時だけ＝提出物の表が窮屈にならない・#673 の知見）。
                広告/天気の read-only プレビューは「プレビュー」タブに集約したのでここには出さない。 */}
            <div className={boardLayout.grid}>
              <section className={boardLayout.full} style={boardCardStyle}>
                <h2 style={boardCardTitleStyle}>予定</h2>
                <ScheduleEditor
                  classId={schedule.classId}
                  date={schedule.date}
                  initialItems={schedule.items}
                />
              </section>
              <section style={boardCardStyle}>
                <h2 style={boardCardTitleStyle}>連絡</h2>
                <NoticeEditor classId={classId} date={date} initialItems={notices.items} />
              </section>
              <section style={boardCardStyle}>
                <h2 style={boardCardTitleStyle}>提出物</h2>
                <AssignmentEditor classId={classId} date={date} initialItems={assignments.items} />
              </section>
            </div>
            {/* 来校者 / 呼び出しは pattern2 専用ブロック（`PATTERN_BLOCKS`）。pattern2 のときだけ 2 カラムで
                出す（pattern1 では盤面に出ないので編集セクションも出さない＝死セクション防止・finding①）。
                各エディタは自前の見出し・幅を持つのでセル内に素直に収まる。 */}
            {showVisitors || showCallouts ? (
              <div className={boardLayout.grid} style={{ marginTop: "1rem" }}>
                {showVisitors && visitors ? (
                  <VisitorsEditor classId={classId} date={date} initialItems={visitors} />
                ) : null}
                {showCallouts && callouts ? (
                  <CalloutsEditor classId={classId} date={date} initialItems={callouts} />
                ) : null}
              </div>
            ) : null}
          </>
        }
        preview={
          <div>
            {/* 黒画面トグル（per-class 運用）。実教室のサイネージを一時的に真っ黒にする / 解除する。実画面に
                即時影響するので押下時に確認を挟む（BlackoutToggle 側）。既存の全画面導線 + 埋め込みプレビューの
                上に置く。 */}
            <BlackoutToggle classId={classId} initialBlackout={blackout} />
            {/* 教室のサイネージに「今どう出るか」をページ内に埋め込む（SignageBoard を直接描画＝iframe/
                シェル二重化なし）。別タブの全画面表示は補助導線として残す。 */}
            <p style={{ margin: "0 0 0.75rem" }}>
              <Link
                href={`/app/signage-preview/${classId}?date=${date}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{ fontSize: "0.9rem", fontWeight: 600, color: tokens.color.primaryHover }}
              >
                別タブで全画面表示 →
              </Link>
            </p>
            {previewDaily ? (
              <div style={previewFrameStyle}>
                <SignageBoard date={date} daily={previewDaily} ads={previewAds} />
              </div>
            ) : (
              <p style={{ color: tokens.color.muted }}>プレビューを表示できませんでした。</p>
            )}
          </div>
        }
      />
      <RememberLastClass classId={classId} />
    </>
  );
}

// 盤面を編集タブの 1 カラムセクションカード（全幅・横スクロール解消）。
const boardCardStyle: React.CSSProperties = {
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.lg,
  padding: "1rem 1.25rem",
};
const boardCardTitleStyle: React.CSSProperties = {
  fontSize: "1.05rem",
  margin: "0 0 0.5rem",
};

// プレビュータブ: サイネージ盤面をページ内に埋め込む枠（白背景＝教室での実表示に近い見え方）。
const previewFrameStyle: React.CSSProperties = {
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.lg,
  padding: "1.25rem",
  background: "#fff",
};

// 画面付随物（戻る/クラス名）を小さく薄く＝主役の邪魔をしないパンくず。
const breadcrumbRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.4rem",
  marginBottom: "0.85rem",
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
// クラス名は h1（見出し階層は維持）だが視覚的には控えめ（小さめ・neutral）にする。
const classTitleStyle: React.CSSProperties = {
  fontSize: tokens.fontSize.sm,
  fontWeight: 600,
  color: tokens.color.neutralFg,
  margin: 0,
};
