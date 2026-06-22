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
import { resolveDesignPattern } from "@/lib/signage/design-pattern";
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
import { FloatingAiChat } from "./_components/FloatingAiChat";
import { RememberLastClass } from "./_components/RememberLastClass";
import { VisitorsCalloutsSection } from "./_components/VisitorsCalloutsSection";
import { WysiwygBoardEditor } from "./_components/WysiwygBoardEditor";

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
    // 「このクラスのサイネージを開く」導線兼**端末別デザインパターン解決**用に、当該クラスの TV デバイスの公開
    // サイネージ URL を引く（同一 tx・RLS 自校限定）。未設置クラスは undefined → リンクを出さない（死リンク防止）。
    const liveSignageUrl = await getClassSignageUrl(tx, classId);
    // サイネージデザインパターンを解決（**端末別 `?design` > 学校レベル既定 > pattern1**）。実機 TV / モニタの壁と
    // 同じ優先順位（`resolveDesignPattern` 単一ソース）で、このクラスの実機が実際に出すパターンでプレビュー・編集
    // セクションを出し分ける（学校既定が pattern1 でも端末が pattern2/3 なら追従＝旧「学校既定のみ参照」を是正）。
    // 来校者一覧 / 生徒呼び出しは `PATTERN_BLOCKS` 上 pattern2/3 専用ブロックなので、パターンに含まれる時だけ
    // 取得・描画する（含まないパターンでは取得もしない＝不要セクションの無条件描画を解消・指摘ログ finding①。
    // 単一ソース `patternIncludesBlock` で駆動し `=== "pattern2"` のハードコード分岐を作らない＝将来パターン追加に
    // 自動追従）。
    const pattern = resolveDesignPattern(liveSignageUrl, await getSignageDesignPattern(tx));
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
    // 予定の列数は実機と同じく pattern3（廊下版）は平日5日、pattern1/2 は3平日（実機 signage-display と一致）。
    // クラス文脈（ヘッダー識別ラベル），天気は予定列ヘッダーのアイコン。
    const previewScheduleDays = await getEffectiveScheduleDays(
      tx,
      classId,
      signageScheduleDates(date, pattern === "pattern3" ? 5 : 3),
    );
    const previewClassContext = await getSignageClassContext(tx, classId);
    // 天気は fail-soft（取得失敗・地域未解決でも盤面の他要素は壊さない）。実機経路と同思想で null に倒す。
    const previewWeather = user.schoolId
      ? await getSignageWeather(tx, user.schoolId, date).catch(() => null)
      : null;
    // liveSignageUrl は上で取得済み（パターン解決と「このクラスのサイネージを開く」導線で共用）。
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
  // `designPattern` はこのクラスの実機が出すパターン（端末別 `?design` 解決済み）。pattern2/3 のクラスでは盤面が
  // Pattern2/3 レイアウトで描かれ、来校者 / 生徒呼び出しは取得済みスナップショット（`showVisitors`/`showCallouts`）
  // を渡して実機どおりに表示する（編集連動は予定のみ・来校者/呼び出しの編集欄は盤面下に出す）。人感センサ / 鉄道は
  // 自動ブロック（編集対象外）なので null 渡しで fail-soft（ウィジェットは不在表示）。
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
        // 防災・安全（自動ブロック・ADR-044）も編集プレビューでは出さない（null＝帯ごと非表示）。pattern1 でも
        // 編集中の盤面には警報/熱中症を描かない（実機の live 表示でのみ出す）。
        weatherWarnings: null,
        heatAlerts: null,
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
          各エディタの key は VisitorsCalloutsSection 内で衝突しない安定キー（visitors-* / callouts-*）にして
          いる。旧実装は両方を同じ key={date} で並べており、対象日変更（?date= ソフトナビ）時に React の keyed
          reconciliation が兄弟キー衝突で破綻 →「来校者一覧」複製・「生徒呼び出し」が下へ押し出される実バグに
          なっていた（本番 6/21→6/22 再現）。日付変更で再マウントし新日付データで初期化する意図は key に date を
          含めて維持する。 */}
      <VisitorsCalloutsSection
        classId={classId}
        date={date}
        showVisitors={showVisitors}
        showCallouts={showCallouts}
        visitors={visitors}
        callouts={callouts}
      />

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
