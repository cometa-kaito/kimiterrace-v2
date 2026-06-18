import { EditorChat } from "@/app/app/editor/_components/EditorChat";
import { isRoleAllowed, requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import type { EditorBoardBase } from "@/lib/editor/editor-board-preview";
import { getClassAssignments, getClassNotices } from "@/lib/editor/notice-assignment-queries";
import { EDITOR_ROLES, isValidDate } from "@/lib/editor/schedule-core";
import { getClassSchedule } from "@/lib/editor/schedule-queries";
import { ADS_ROLES } from "@/lib/school-admin/ads-core";
import { QUIET_HOURS_ROLES } from "@/lib/school-admin/quiet-hours-core";
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
  getClassSignageUrl,
  getEffectiveAdsForClass,
  getSignageClassContext,
  getVisitorsForClass,
} from "@kimiterrace/db";
import { tokens } from "@kimiterrace/ui";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BlackoutToggle } from "./_components/BlackoutToggle";
import { CalloutsEditor } from "./_components/CalloutsEditor";
import { FloatingAiChat } from "./_components/FloatingAiChat";
import { RememberLastClass } from "./_components/RememberLastClass";
import { VisitorsEditor } from "./_components/VisitorsEditor";
import { WysiwygBoardEditor } from "./_components/WysiwygBoardEditor";
import boardLayout from "./_components/board-layout.module.css";

/**
 * クラス別エディタ — **盤面エディタを本画面・AI は浮遊チャット**（ユーザー判断 2026-06-16）。
 *
 * `/app` 配下 (#48-C layout で認証) + 本ページで `EDITOR_ROLES` (teacher / school_admin) に限定。
 * `?date=YYYY-MM-DD` で対象日（既定は JST 今日）。別テナントのクラスは RLS 不可視 → 404。
 *
 * **構成（タブ shell 廃止）**: WYSIWYG 盤面エディタ（{@link WysiwygBoardEditor}）を直接の本画面にし
 * （ライブ盤面が旧「プレビュー」タブを兼ねるので preview タブは廃止）、会話型 AI（{@link EditorChat}）は
 * 右下に浮く支援チャット（{@link FloatingAiChat} の FAB → パネル）に格下げする。`広告管理` / `静粛時間` は
 * school_admin の per-class 管理導線として盤面の上に残す（teacher には出さない＝死リンク防止）。
 * 黒画面トグル（{@link BlackoutToggle}）は実教室へ即時影響する強い操作なので最下部にまとめる。
 *
 * 反映の取りこぼし防止: 会話の下書きを**現在の盤面でシード**する（per-section save は置換のため、AI が
 * 触れなかったセクションも全体像として保持してから反映する）。`key={date}`（対象日変更で各エディタ・AI を
 * 再マウントし新日付で初期化）と Approach A（盤面実セクションを覆う編集ボタン）は維持する。
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
    // 「このクラスのサイネージを開く」導線用に、当該クラスの TV デバイスの公開サイネージ URL を引く
    // （同一 tx・RLS 自校限定）。未設置クラスは undefined → リンクを出さない（死リンク防止）。
    const liveSignageUrl = await getClassSignageUrl(tx, classId);
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
      liveSignageUrl,
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
    liveSignageUrl,
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
        // 工学ニュース（自動ブロック・ADR-043）は鉄道/センサと同じく編集プレビューでは出さない（null）。
        news: null,
        blackout,
      }
    : null;

  return (
    <>
      {/* 画面付随物（戻る + クラス名）は小さく薄いパンくずに格下げ＝主役（盤面エディタ）に視線が向くように
          する（ユーザー指摘 2026-06-15）。クラス名は h1 を保ち見出し階層は崩さず、視覚的にのみ控えめにする。
          ?stay=1 は単一クラス teacher の自動直行（着地）とのループ防止。 */}
      <nav aria-label="パンくず" style={breadcrumbRowStyle}>
        <Link href="/app/editor?stay=1" style={breadcrumbBackStyle}>
          <span aria-hidden="true">‹</span> 戻る
        </Link>
        <span aria-hidden="true" style={breadcrumbSepStyle}>
          ／
        </span>
        <h1 style={classTitleStyle}>{schedule.className}</h1>
      </nav>

      {/* 広告管理 / 静粛時間は school_admin の per-class 管理導線。teacher には出さない（死リンク防止）。盤面の上に残す。 */}
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

      {/* 本画面: 実サイネージ配置（50 インチ TV と同一の `SignageBoardView`）の上で見ながら編集する WYSIWYG。
          ライブ盤面が旧「プレビュー」タブを兼ねるので preview タブは廃止した。領域クリックで該当セクションの
          編集欄へ移動・フォーカスする（連動プレビュー）。各セクションの保存・検証・自動保存・scope・RLS/監査は
          従来の ScheduleEditor / NoticeEditor / AssignmentEditor が温存して担う。見出し「予定」「連絡」「提出物」と
          placeholder は維持（e2e 温存）。スマホ（≤899px）はプレビューを畳み従来の縦積みフォームに倒す。
          key={date}: 対象日変更時に再マウントして新日付のデータで初期化する。これが無いと配下エディタの
          useState(initial...) が再初期化されず、旧日付の入力が残ったまま保存され「中身が変更先の日付に移る」
          混線バグになる（ユーザー報告 2026-06-16）。 */}
      <WysiwygBoardEditor
        key={date}
        classId={classId}
        date={date}
        base={boardBase}
        initialSchedules={schedule.items}
        initialNotices={notices.items}
        initialAssignments={assignments.items}
      />

      {/* 来校者 / 呼び出しは pattern2 専用ブロック（`PATTERN_BLOCKS`）。pattern2 のときだけ 2 カラムで盤面の
          下に出す（pattern1 では盤面に出ないので編集セクションも出さない＝死セクション防止・finding①）。
          key={date}: 対象日変更で再マウントし新日付データで初期化（中身の混線防止・上記と同理由）。 */}
      {showVisitors || showCallouts ? (
        <div className={boardLayout.grid} style={{ marginTop: "1rem" }}>
          {showVisitors && visitors ? (
            <VisitorsEditor key={date} classId={classId} date={date} initialItems={visitors} />
          ) : null}
          {showCallouts && callouts ? (
            <CalloutsEditor key={date} classId={classId} date={date} initialItems={callouts} />
          ) : null}
        </div>
      ) : null}

      {/* 実機サイネージへの導線。旧「別タブで全画面表示」（内部プレビュー /app/signage-preview）は、TV が実際に
          表示している**公開サイネージサイト**（tv_devices.signage_url = /signage/{token}）へ差し替え（ユーザー判断
          2026-06-16）。これは Next アプリ内ルートだが別 host/別 origin になりうる絶対 URL なので素の <a> で開く
          （client-side prefetch を避ける）。編集を失わないよう別タブで開く（rel=noopener）。設置 TV が無いクラスは
          liveSignageUrl が undefined → リンク自体を出さない（死リンク防止・本ファイルの導線方針と一貫）。 */}
      {liveSignageUrl ? (
        <p style={{ margin: "1.5rem 0 0.75rem" }}>
          <a
            href={liveSignageUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: "0.9rem", fontWeight: 600, color: tokens.color.primaryHover }}
          >
            このクラスのサイネージを開く →
          </a>
        </p>
      ) : null}

      {/* 黒画面トグル（per-class 運用）= 編集画面の最下部。実教室のサイネージを一時的に真っ黒にする / 解除する。
          実画面に即時影響するので押下時に確認を挟む（BlackoutToggle 側）。見出し・現在状態・説明文も内包する。 */}
      <section aria-labelledby="blackout-heading" style={blackoutSectionStyle}>
        <h2 id="blackout-heading" style={blackoutHeadingStyle}>
          サイネージを黒画面にする
        </h2>
        <BlackoutToggle classId={classId} initialBlackout={blackout} />
      </section>

      <RememberLastClass classId={classId} />

      {/* AI は右下に浮く支援チャット（タブ shell 廃止）。FAB → パネルで開閉。会話・保存・SSE は EditorChat が温存。
          key={date}: 対象日変更で再マウントし新日付の下書きで初期化する（key 無しだと旧日付の中身が残り保存で混線する）。 */}
      <FloatingAiChat>
        <EditorChat
          key={date}
          scope="class"
          targetId={classId}
          date={date}
          initialDraft={{
            schedules: schedule.items,
            notices: notices.items,
            assignments: assignments.items,
          }}
          variant="floating"
        />
      </FloatingAiChat>
    </>
  );
}

// 黒画面トグル節（編集画面の最下部）。見出し + トグル + 説明をまとめる枠。
const blackoutSectionStyle: React.CSSProperties = {
  marginTop: "2rem",
  paddingTop: "1.25rem",
  borderTop: `1px solid ${tokens.color.border}`,
};
const blackoutHeadingStyle: React.CSSProperties = {
  fontSize: tokens.fontSize.md,
  fontWeight: 600,
  color: tokens.color.ink,
  margin: "0 0 0.6rem",
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
