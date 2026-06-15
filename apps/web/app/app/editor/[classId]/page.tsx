import { EditorChat } from "@/app/app/editor/_components/EditorChat";
import { isRoleAllowed, requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import type { EditorBoardBase } from "@/lib/editor/editor-board-preview";
import { getClassAssignments, getClassNotices } from "@/lib/editor/notice-assignment-queries";
import { EDITOR_ROLES, isValidDate } from "@/lib/editor/schedule-core";
import { getClassSchedule } from "@/lib/editor/schedule-queries";
import { ADS_ROLES } from "@/lib/school-admin/ads-core";
import { QUIET_HOURS_ROLES } from "@/lib/school-admin/quiet-hours-core";
import { SignageBoard } from "@/app/app/signage-preview/[classId]/_components/SignageBoard";
import { getClassSignageBlackout } from "@/lib/signage/blackout";
import {
  getEffectiveDailyData,
  getEffectiveScheduleDays,
} from "@/lib/signage/effective-daily-data";
import { patternIncludesBlock } from "@/lib/signage/pattern-blocks";
import { signageScheduleDates } from "@/lib/signage/rotation";
import { getSignageDesignPattern } from "@/lib/signage/signage-design";
import { getSignageWeather } from "@/lib/signage/weather";
import {
  getCalloutsForClass,
  getEffectiveAdsForClass,
  getSignageClassContext,
  getVisitorsForClass,
} from "@kimiterrace/db";
import { tokens } from "@kimiterrace/ui";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BlackoutToggle } from "./_components/BlackoutToggle";
import { CalloutsEditor } from "./_components/CalloutsEditor";
import { ClassEditorShell } from "./_components/ClassEditorShell";
import { RememberLastClass } from "./_components/RememberLastClass";
import { VisitorsEditor } from "./_components/VisitorsEditor";
import { WysiwygBoardEditor } from "./_components/WysiwygBoardEditor";
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
    // プレビュー / WYSIWYG 用: 教室のサイネージに実際どう出るか（class>grade>dept>school のマージ結果 + 実効広告）。
    const previewDaily = await getEffectiveDailyData(tx, classId, date);
    const previewAds = await getEffectiveAdsForClass(tx, classId);
    // プレビュータブの黒画面トグル初期値（class スコープ display_settings.blackout）。同一 tx・RLS 自校限定。
    const blackout = await getClassSignageBlackout(tx, classId);
    // WYSIWYG（盤面を編集タブ）の実機ライブプレビュー用に、実機 `getSignageDisplayData` と同じ基底データを
    // **同一 tx・RLS 自校限定**で取得する（盤面 `SignageBoardView` を実機と一致させるため・重複実装しない）。
    // 予定は今後 3 平日の 3 列（実機と同じ），クラス文脈（ヘッダー識別ラベル），天気は予定列ヘッダーのアイコン。
    const previewScheduleDays = await getEffectiveScheduleDays(
      tx,
      classId,
      signageScheduleDates(date, 3),
    );
    const previewClassContext = await getSignageClassContext(tx, classId);
    // 天気は fail-soft（取得失敗・地域未解決でも盤面の他要素は壊さない）。実機経路と同思想で null に倒す。
    const previewWeather = user.schoolId
      ? await getSignageWeather(tx, user.schoolId, date).catch(() => null)
      : null;
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
      pattern,
      previewScheduleDays,
      previewClassContext,
      previewWeather,
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
    pattern,
    previewScheduleDays,
    previewClassContext,
    previewWeather,
  } = data;

  // WYSIWYG（盤面を編集タブ）のライブプレビュー基底スナップショット。`previewDaily` が取れた時だけ盤面を出す
  // （取れない時は WysiwygBoardEditor 側がプレビューを畳んで従来フォームのみにフォールバック＝盤面を壊さない）。
  // pattern2 専用ブロック（来校者/呼び出し/センサ/鉄道）は編集タブのプレビューでは出さない（盤面は実機の
  // pattern2 でも右の広告と予定主体で、ここでは予定/連絡/提出物の編集連動に集中する）。null 渡しで fail-soft。
  const boardBase: EditorBoardBase | null = previewDaily
    ? {
        date,
        designPattern: pattern,
        daily: previewDaily,
        scheduleDays: previewScheduleDays,
        ads: previewAds,
        weather: previewWeather,
        classContext: previewClassContext,
        presenceCount: null,
        visitors: showVisitors ? visitors : null,
        callouts: showCallouts ? callouts : null,
        trainStatus: null,
        blackout,
      }
    : null;

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
            {/* 盤面を編集タブ: 実サイネージ配置（50 インチ TV と同一の `SignageBoardView`）の上で見ながら編集する
                WYSIWYG（PR・B）。上段に実機と同一レイアウトの大きなライブプレビューを出し、領域クリックで該当
                セクションの編集欄へ移動・フォーカスする（連動プレビュー）。各セクションの保存・検証・自動保存・
                scope・RLS/監査は従来の ScheduleEditor / NoticeEditor / AssignmentEditor が温存して担う（UI 導線
                だけを実配置上の編集に載せ替え）。見出し「予定」「連絡」「提出物」と placeholder は維持（e2e 温存）。
                スマホ（≤899px）はプレビューを畳み従来の縦積みフォームに倒す。 */}
            <WysiwygBoardEditor
              classId={classId}
              date={date}
              base={boardBase}
              initialSchedules={schedule.items}
              initialNotices={notices.items}
              initialAssignments={assignments.items}
            />
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
