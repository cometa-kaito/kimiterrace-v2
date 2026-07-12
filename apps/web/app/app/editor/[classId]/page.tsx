import { EditorDraftSyncProvider } from "@/app/app/editor/_components/EditorDraftSyncContext";
import { isRoleAllowed, requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { resolveClassBoardForDate, resolveEditorTargetDate } from "@/lib/editor/board-context";
import { getClassContentDates, monthWindow } from "@/lib/editor/content-dates";
import { CALENDAR_IMPORT_PAGE_PATH } from "@/lib/editor/day-events";
import { getEditorDayEvents } from "@/lib/editor/day-events-queries";
import {
  editorDateSegments,
  editorPreviewPath,
  jpDateLabel,
  planRedirectPath,
} from "@/lib/editor/default-date";
import type { EditorBoardBase } from "@/lib/editor/editor-board-preview";
import {
  getClassAssignments,
  getClassCarryoverDailyRows,
  getClassNotices,
  getClassPinnedNoticeRows,
} from "@/lib/editor/notice-assignment-queries";
import { EDITOR_ROLES } from "@/lib/editor/schedule-core";
import { getClassSchedule } from "@/lib/editor/schedule-queries";
import { seedSchedulesForDate } from "@/lib/editor/weekly-timetable-core";
import { getClassWeeklyTimetable } from "@/lib/editor/weekly-timetable-queries";
import { ADS_ROLES } from "@/lib/school-admin/ads-core";
import { QUIET_HOURS_ROLES } from "@/lib/school-admin/quiet-hours-core";
import { parseAssignmentDeadlineFormat } from "@/lib/signage/assignment-deadline-format";
import {
  EFFECTIVE_LOOKBACK_DAYS,
  activeCarryoverItemsOutsideDate,
  activePinnedNoticeItemsOutsideDate,
  addDays,
} from "@/lib/signage/effective-daily-data";
import {
  blockLabel,
  editableBlocksForPattern,
  patternIncludesBlock,
  scheduleInputVariant,
} from "@/lib/signage/pattern-blocks";
import { jstDateString } from "@/lib/signage/rotation";
import { tokens } from "@kimiterrace/ui";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { BlackoutToggle } from "./_components/BlackoutToggle";
import { ClassEditorChat } from "./_components/ClassEditorChat";
import { CopyPreviousDayButton } from "./_components/CopyPreviousDayButton";
import { EDITOR_STACK_ANCHOR_ID } from "./_components/editor-anchors";
import { CopyPreviousWeekButton } from "./_components/CopyPreviousWeekButton";
import { DayEventsPanel } from "./_components/DayEventsPanel";
import { EditorDateCalendar } from "./_components/EditorDateCalendar";
import { EditorDateSegments } from "./_components/EditorDateSegments";
import { FloatingAiChat } from "./_components/FloatingAiChat";
import { RememberLastClass } from "./_components/RememberLastClass";
import { SeedConfirmButton } from "./_components/SeedConfirmButton";
import { WysiwygBoardEditor } from "./_components/WysiwygBoardEditor";

/**
 * クラス別エディタ — **単一編集スタック + 対象日セグメント + 3 ゾーン分層**
 * （editor-restructure-bulletin-2026-07.md §3・オーナー決定 3）。
 *
 * `/app` 配下 (#48-C layout で認証) + 本ページで `EDITOR_ROLES` (teacher / school_admin) に限定。
 * 別テナントのクラスは RLS 不可視 → 404。
 *
 * **対象日モデル（§3.2）**: 編集スタックは常に 1 つ。対象日はゾーン1先頭のセグメント
 * （今日 → 翌授業日 → … → 📅 月カレンダー）で切り替え、盤面プレビュー・編集セクション・AI FAB・
 * 前日コピーがすべてその日に追随する。`?date=YYYY-MM-DD` が明示されていれば常にそれが対象日。無指定の
 * 既定は {@link resolveDefaultEditorDate}（授業日の下校時刻 `editorDayCutover`・既定 16:00 まで＝今日、
 * それ以降と休日＝次の授業日）。旧 `?plan=X`（今日＋選択日の 2 スタック並存）は**廃止**し、後方互換で
 * `?date=X` へ redirect する（§3.3・ブックマーク/履歴を壊さない）。
 *
 * **3 ゾーン分層（§3.1・v2-ed47-4 の是正）**: 毎日の編集（セグメント＋盤面 WYSIWYG＋編集セクション）／
 * 計画（前日・前週コピー、基本時間割、月カレンダー）／このモニタ（サイネージを開く・黒画面・
 * school_admin の広告管理/静粛時間）を視覚的に分ける。
 *
 * 反映の取りこぼし防止: 会話の下書きを**現在の盤面でシード**する（per-section save は置換のため、AI が
 * 触れなかったセクションも全体像として保持してから反映する）。`key={date}:{copied}`（対象日変更・コピーで
 * 各エディタ・AI を再マウントし新データで初期化）は**絶対に維持**する（無いと旧日付の入力が新日付へ保存
 * される混線バグが再発する・2026-06-16 実バグ）。フォーム側の key はさらに `:{applied}`（AI 反映の nonce）を
 * 持ち、反映後データで再マウントする（AI チャットの key には含めない＝会話を保つ・2026-07-06 P1）。
 */
export default async function ClassEditorPage({
  params,
  searchParams,
}: {
  params: Promise<{ classId: string }>;
  searchParams: Promise<{ date?: string; plan?: string; copied?: string; applied?: string }>;
}) {
  const user = await requireRole(EDITOR_ROLES);
  const { classId } = await params;
  // 広告管理 / 静粛時間は school_admin / system_admin 専任。teacher には出さない（死リンク防止）。
  const canManageAds = isRoleAllowed(user.role, ADS_ROLES);
  const canManageQuietHours = isRoleAllowed(user.role, QUIET_HOURS_ROLES);
  const {
    date: dateParam,
    plan: planParam,
    copied: copiedParam,
    applied: appliedParam,
  } = await searchParams;
  // 旧 `?plan=X`（2 スタック時代の下スタック URL）は `?date=X` へ後方互換 redirect（§3.3）。恒久 URL では
  // ないので Next 既定の 307 で十分。不正な plan 値は無視して既定挙動に fail-soft。
  const planRedirect = planRedirectPath(classId, planParam);
  if (planRedirect) {
    redirect(planRedirect);
  }
  // 前日/前週コピー成功時の再マウント nonce（CopyPreviousDayButton が ?copied=<ts> を付けて再ナビゲート）。
  // エディタ key に含めることで、同一日付への複製でも配下エディタの useState(initial…) を複製後データで
  // 確実に再初期化する（key={date} だけでは同じ日への操作で再マウントされない）。値は key 用の不透明文字列
  // なので形式検証は長さ制限のみ（fail-soft）。
  const copied = typeof copiedParam === "string" ? copiedParam.slice(0, 24) : "";
  // AI 反映成功時の再マウント nonce（ClassEditorChat が ?applied=<ts> を付けて再ナビゲート）。copied と同じ
  // 確立済み手法で、**フォーム側（WysiwygBoardEditor）の key にだけ**含める＝反映後データで各セクション
  // 編集器を再初期化しつつ、AI チャット（key は date:copied のまま）の会話・パネル状態は保つ（2026-07-06 P1:
  // 反映後もフォームが古いまま→次の自動保存が AI 反映分を上書き消去する実証バグの是正）。
  const applied = typeof appliedParam === "string" ? appliedParam.slice(0, 24) : "";
  const now = new Date();
  const today = jstDateString(now);

  const data = await withSession(async (tx) => {
    // 対象日の解決（`?date=` 明示は常に優先＝deep link 安定。無指定・不正値は school_configs の cutover から
    // 既定対象日を決める）。display_settings は 1 回だけ読み、後段のデザインパターン解決でも使う。
    // 実寸プレビューページ（`…/preview`）と共有の単一ソース（board-context.ts・#1257）。
    const { date, displaySettings } = await resolveEditorTargetDate(tx, dateParam, now);
    const schedule = await getClassSchedule(tx, classId, date);
    if (!schedule) {
      return null;
    }
    // 編集フォームの初期値は**クラス直の**当日セクション（編集対象＝raw）。盤面プレビューの基底（下記 `board`）は
    // class>grade>dept>school のマージ結果なので、編集フォーム用にはこちらを別途引く（用途が違う）。
    const notices = await getClassNotices(tx, classId, date);
    const assignments = await getClassAssignments(tx, classId, date);
    // 固定中のお知らせ（pinned・F-C §5.4）: 対象日以外の日に入力された固定行は連絡エディタに出てこない
    // （幽霊化）ため、クラス直の固定行を全期間で引いて「固定中のお知らせ」一覧（削除導線）に渡す。
    const pinnedNotices = await getClassPinnedNoticeRows(tx, classId);
    // 持ち越し合成（忠実度 2026-07-06）: 対象日より前の遡及窓（実盤面と同じ EFFECTIVE_LOOKBACK_DAYS）の
    // クラス直行を読む。対象日に活性な非 pinned 連絡・提出物をプレビューへ合成するため（抽出は下の純関数）。
    const carryoverRows = await getClassCarryoverDailyRows(
      tx,
      classId,
      date,
      addDays(date, -(EFFECTIVE_LOOKBACK_DAYS - 1)),
    );
    // 週次ベース時間割（F5・コピーオンライト）: 対象日の予定が空のとき、その曜日の基本時間割をエディタの初期値に
    // seed するために引く（自校 RLS・同一 tx）。テンプレ未登録は空。盤面の表示時マージはしない（seed は編集初期値のみ）。
    const weeklyTimetable = (await getClassWeeklyTimetable(tx, classId))?.timetable ?? {};
    // 実機 URL（「実機の画面を開く」導線）→ 端末別デザインパターン解決 → 実機と完全同一の payload builder
    // （`buildSignagePayloadForClass`）による盤面基底、をエディタ/実寸プレビュー共有の単一ソース
    // （`resolveClassBoardForDate`・board-context.ts・#1257）で組む。自動コンテンツ系ブロックも実機と同じ
    // 取得ゲート・同じ fail-soft で取得・描画される。schoolId 不明時は board=null（盤面を出さず
    // WysiwygBoardEditor が従来の縦積みフォームへ fail-soft フォールバック）。
    const { liveSignageUrl, pattern, board } = await resolveClassBoardForDate(
      tx,
      classId,
      user.schoolId,
      date,
      displaySettings,
    );
    // 提出物の期日表示形式（#1258 学校別設定）。resolveEditorTargetDate が読んだ同じ display_settings から
    // 相乗りでパースし（1 回読み設計を維持）、AI チャットの下書きプレビュー表記を実機盤面（board 経由の
    // WYSIWYG プレビュー）と一致させる。
    const deadlineFormat = parseAssignmentDeadlineFormat(displaySettings);
    // 来校者一覧 / 生徒呼び出しは `PATTERN_BLOCKS` 上 pattern2/3 専用の**編集対象**ブロック。盤面下の編集欄を
    // 出すかの判定に使う（実機と同じ取得結果は `board.visitors` / `board.callouts` に載る）。`patternIncludesBlock`
    // 単一ソース駆動で `=== "pattern2"` のハードコード分岐を作らない（将来パターン追加に自動追従）。
    const showVisitors = patternIncludesBlock(pattern, "visitor");
    const showCallouts = patternIncludesBlock(pattern, "callout");
    // カレンダー（内容ドット）用: 対象日の月±1 か月を自校 RLS 内で引く。
    const calWindow = monthWindow(date);
    const contentDates = await getClassContentDates(tx, classId, calWindow.start, calWindow.end);
    // 「この日の行事」（ADR-049 決定 7・PR-D）: 編集中日付に該当する学校行事（school_calendar_events・
    // iCal / ファイル取込の両由来）を同じ RLS tx 内で読む（getCalendarEvents 委譲・複数日行事の当日包含は
    // day-events が判定）。schoolId 不明（想定外）は空＝パネル非表示に fail-soft。
    const dayEvents = user.schoolId ? await getEditorDayEvents(tx, user.schoolId, date) : [];
    return {
      date,
      schedule,
      notices,
      assignments,
      pinnedNotices,
      pattern,
      deadlineFormat,
      showVisitors,
      showCallouts,
      board,
      liveSignageUrl,
      contentDates,
      weeklyTimetable,
      carryoverRows,
      dayEvents,
    };
  });
  // クラスが自校で不可視 (別テナント / 存在しない) なら schedule が null → 404。
  if (!data || !data.notices || !data.assignments) {
    notFound();
  }
  const {
    date,
    schedule,
    notices,
    assignments,
    pinnedNotices,
    pattern,
    deadlineFormat,
    showVisitors,
    showCallouts,
    board,
    liveSignageUrl,
    contentDates,
    weeklyTimetable,
    carryoverRows,
    dayEvents,
  } = data;

  // 対象日セグメント（§3.1）: 今日を常に先頭に、翌授業日からの授業日を時系列で並べる（サーバ決定＝
  // ハイドレーション安全）。任意日はセグメント末尾の「📅 ほかの日」→ 月カレンダー（計画ゾーン）が担う。
  const segmentDates = editorDateSegments(today);

  // 予定エディタの時限入力形態（単一ソース `scheduleInputVariant`）。掲示板型（pattern5）は「時刻＋内容」で
  // 書くため、時限ベースの基本時間割（週次テンプレ）は seed も導線も出さない（§6.2・語彙不一致の再発防止）。
  const periodSchedule =
    patternIncludesBlock(pattern, "schedule") && scheduleInputVariant(pattern) === "period";

  // コピーオンライト seed（F5）: 対象日の予定が**空 かつ 平日**なら、その曜日の基本時間割をエディタの初期値に
  // する（教員は確認・差分編集して保存＝daily_data へ materialize。**保存前の daily_data には書かない**）。
  // 既に入力がある日・土日はそのまま（seed しない）。盤面の表示は daily_data のみ。時限入力でないパターン
  //（掲示板型）には時限テンプレを流し込まない（seed しない）。
  const seed = periodSchedule
    ? seedSchedulesForDate(date, schedule.items, weeklyTimetable)
    : { items: schedule.items, seeded: false };

  // WYSIWYG のライブプレビュー基底スナップショット。`board` は実機 `buildSignagePayloadForClass` の出力
  // （`SignagePayload`）で、`EditorBoardBase` はその表示用フィールドの `Pick` なのでそのまま渡せる。
  const boardBase: EditorBoardBase | null = board;

  // 他日入力の・対象日に活性な固定行（pinned・Reviewer MEDIUM-2）。実 TV は窓マージで表示しているため、
  // ライブプレビューにも draft の前置きで合成して実機と一致させる（活性判定は単一ソース isNoticeActive）。
  const previewPinnedNotices = activePinnedNoticeItemsOutsideDate(pinnedNotices, date);

  // 他日入力の・対象日に活性な**持ち越し**（非 pinned 連絡=表示日数>1・提出物=期限+猶予・忠実度 2026-07-06）。
  // 実 TV は窓マージで表示しているため、プレビューにも合成して「実機には出ているのにプレビューでは消えている」
  // 過少表示（→教員の二重入力・無駄な前日コピー）を防ぐ。活性判定は単一ソース（is*Active）。
  const previewCarryover = activeCarryoverItemsOutsideDate(carryoverRows, date);

  return (
    // EditorDraftSyncProvider: フォーム（WysiwygBoardEditor）の「今この瞬間」の状態を会話 AI（EditorChat）と
    // 共有する ref ブリッジ（DOM は生やさない）。AI の下書き基底をロード時スナップショットでなく会話開始時の
    // フォーム現在値にする（P1: ロード後の手入力を AI が知らず反映で消す穴の是正・EditorDraftSyncContext 参照）。
    <EditorDraftSyncProvider>
      {/* 画面付随物（戻る + クラス名）は小さく薄いパンくず＝主役（盤面エディタ）に視線が向くようにする。
          クラス名は h1 を保ち見出し階層は崩さず、視覚的にのみ控えめにする。
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

      {/* ─ ゾーン1: 毎日の編集（§3.1）─ 対象日セグメント → 「編集中: ◯月◯日」 → 盤面 WYSIWYG → 編集セクション。
          編集スタックは常に 1 つで、セグメント切替（?date= ソフトナビ）で全体がその日に追随する。
          id=EDITOR_STACK_ANCHOR_ID: 月カレンダーで日付を選んだ後の「編集エリアへ戻る」スクロール先。
          旧来はセグメント nav に付いていたが、#1237 で nav が sticky バー内に入り「常に視界内」となって
          scrollIntoView が空振りしていた（2026-07-06 実画面監査で実証）。非 sticky のゾーン先頭へ移設。 */}
      <section aria-labelledby="zone-daily-heading" id={EDITOR_STACK_ANCHOR_ID}>
        {/* key={date}:{copied}:{applied}: 対象日変更・コピー・AI 反映時に再マウントして新データで初期化する。これが
            無いと配下エディタの useState(initial...) が再初期化されず、旧日付の入力が残ったまま保存され「中身が
            変更先の日付に移る」混線バグ（ユーザー報告 2026-06-16・設計書 §11-1）や、AI 反映後の古いフォームの
            自動保存が反映分を上書き消去するデータ消失（2026-07-06 実証 P1）になる。 */}
        {/* 単一の盤面エディタが「盤面プレビュー（左・sticky）＋ 編集セクション（右・独立スクロール）」の 2 カラム
            （配置最適化 2026-07-05・user-observed）を担う。来校者 / 呼び出し（pattern2/3・`patternIncludesBlock`
            駆動）も編集カラムに同居させ、盤面プレビューを見失わずに編集できる。含むパターンのときだけ出す（死
            セクション防止・将来パターン追加にも単一ソースで自動追従）。対象日ソフトナビ（?date=）時の複製/押し出し
            バグ（本番 6/21→6/22）回避のため、VisitorsCalloutsSection は WysiwygBoardEditor 内に単一の安定
            コンポーネントとして 1 つだけ描く（設計書 §11-2）。
            dayHeader（日付タブ+「毎日の編集」見出し+「編集中」）は盤面と同じ左パネル（sticky）に入れて一体で固定する
            ため node で渡す（ちらつき解消 2026-07-05・user #1: 日付タブが static でスクロール消失し盤面だけ残る差分が
            ちらつきの原因だった）。 */}
        <WysiwygBoardEditor
          key={`${date}:${copied}:${applied}`}
          classId={classId}
          date={date}
          base={boardBase}
          initialSchedules={seed.items}
          initialNotices={notices.items}
          initialAssignments={assignments.items}
          pinnedNotices={pinnedNotices}
          previewPinnedNotices={previewPinnedNotices}
          previewCarryover={previewCarryover}
          showVisitors={showVisitors}
          showCallouts={showCallouts}
          visitors={board?.visitors ?? null}
          callouts={board?.callouts ?? null}
          // 実物サイネージへの直結リンク（盤面直下・本物一致の確認動線）。未設置クラスは undefined＝出さない。
          liveSignageUrl={liveSignageUrl}
          // 計画系の即応操作（FHD 配置最適化 2026-07-06）: 前日/前週コピー・基本時間割リンクを盤面直下（左
          // sticky カラム）へ常駐させる。「昨日と同じ＋1ヶ所変更」の最頻ワークフローがスクロールゼロで完結する
          // （旧: ページ最下部のゾーン2まで往復）。ゾーン2は月カレンダー（任意日選択）に純化。実体（上書き確認・
          // ?copied= 再ナビ・パターン別ラベル・対象日追随）は各ボタンが従来どおり担う＝配置のみの変更。
          // 「年間予定表を取り込む →」も年 1 回の設定操作（基本時間割設定と同型）＝ここに常設し、行事が 1 件も
          // 無い教員にも初回導線を保証する（DayEventsPanel は行事 0 件で非表示＝そこ頼みだと鶏と卵になる・
          // #1269 follow-up）。取込ページと同じ EDITOR_ROLES ゲートなので死/forbidden リンクにならない。
          planActions={
            <>
              <CopyPreviousDayButton
                classId={classId}
                date={date}
                hasExistingData={
                  (patternIncludesBlock(pattern, "schedule") && schedule.items.length > 0) ||
                  (patternIncludesBlock(pattern, "notice") && notices.items.length > 0) ||
                  (patternIncludesBlock(pattern, "assignment") && assignments.items.length > 0) ||
                  (board?.visitors?.length ?? 0) > 0 ||
                  (board?.callouts?.length ?? 0) > 0
                }
                sectionsLabel={editableBlocksForPattern(pattern)
                  .map((block) => blockLabel(pattern, block))
                  .join("・")}
              />
              <CopyPreviousWeekButton classId={classId} />
              {periodSchedule ? (
                <Link href={`/app/editor/${classId}/timetable`} style={{ fontSize: "0.9rem" }}>
                  基本時間割を設定 →
                </Link>
              ) : null}
              <Link href={CALENDAR_IMPORT_PAGE_PATH} style={{ fontSize: "0.9rem" }}>
                年間予定表を取り込む →
              </Link>
            </>
          }
          // 「この日の行事」（ADR-049 決定 7・PR-D）: 編集中日付の学校行事をワンクリックで予定 / 連絡へ確定
          // 挿入するパネル（盤面直下）。行事 0 件の日は渡さない（非表示）。挿入基底の fail-soft（共有 ref
          // 未確立時）はフォームの初期値（seed 済み予定 / 連絡）と同一値＝盤面に見えているものが基底になる。
          // 「予定へ追加 / 連絡へ追加」は実効パターンが該当ブロックを持つときだけ出す（死ボタン防止・
          // patternIncludesBlock 単一ソース駆動）。
          dayEventsPanel={
            dayEvents.length > 0 ? (
              <DayEventsPanel
                classId={classId}
                date={date}
                events={dayEvents}
                canAddSchedule={patternIncludesBlock(pattern, "schedule")}
                canAddNotice={patternIncludesBlock(pattern, "notice")}
                fallbackSchedules={seed.items}
                fallbackNotices={notices.items}
              />
            ) : null
          }
          dayHeader={
            <>
              {/* 「毎日の編集」ラベルは視覚的に隠す（sr-only）＝画面から消して縦を節約するが、section の
                  aria-labelledby 参照とスクリーンリーダ向けの節ラベルは維持（引き算 2026-07-05 user 要望
                  「ヘッダーが領域を取りすぎ」。日付タブが自明なので視覚ラベルは不要）。 */}
              <h2 id="zone-daily-heading" style={srOnlyStyle}>
                毎日の編集
              </h2>
              <EditorDateSegments
                classId={classId}
                today={today}
                selectedDate={date}
                segmentDates={segmentDates}
              />
              {/* 編集中の対象日の明示（受入基準 PR-A-1）。セグメントの選択強調と二重で伝える（色だけに頼らない）。 */}
              <p style={editingHeadingStyle}>
                編集中: {jpDateLabel(date)}
                {date === today ? "（今日）" : ""}
              </p>
              {/* 基本時間割からの seed 注記（F5）: seed が効いている日だけ出す。プレビューには出るが保存する
                  まで実サイネージには出ないため、状態を明文化し**ワンクリック確定**（SeedConfirmButton＝既存の
                  保存経路 + ?applied= 再マウント）を添える（忠実度 2026-07-06: 「もう実機にも出ている」誤認と
                  「確定手段がどこかを1ヶ所編集するだけ」の分かりにくさの是正）。 */}
              {seed.seeded && seed.items.length > 0 ? (
                <p style={seedNoteStyle}>
                  基本時間割から下書き表示中（まだ実際の盤面には出ていません）{" "}
                  <SeedConfirmButton classId={classId} date={date} items={seed.items} />
                </p>
              ) : null}
            </>
          }
        />
      </section>

      {/* ─ ゾーン2: 計画（§3.1）─ 月カレンダー（任意日の選択）。前日/前週コピー・基本時間割リンクは
          FHD 配置最適化（2026-07-06）で盤面直下（WysiwygBoardEditor の planActions・上記）へ常駐化し、
          このゾーンはカレンダーに純化した。 */}
      <section aria-labelledby="zone-plan-heading" style={zoneSectionStyle}>
        <h2 id="zone-plan-heading" style={zoneLabelStyle}>
          計画
        </h2>
        {/* 月カレンダー: 対象日そのものを選ぶ（?date= 一本化・旧 ?plan の第 2 スタックは廃止）。セグメントの
            「📅 ほかの日」がここへスクロールして開く。選択後はゾーン1先頭（EDITOR_STACK_ANCHOR_ID）へ戻す。 */}
        <EditorDateCalendar
          classId={classId}
          today={today}
          selectedDate={date}
          contentDates={contentDates}
        />
      </section>

      {/* ─ ゾーン3: このモニタ（§3.1）─ 実機サイネージへの導線・黒画面・school_admin の per-class 管理導線。 */}
      <section aria-labelledby="zone-monitor-heading" style={zoneSectionStyle}>
        <h2 id="zone-monitor-heading" style={zoneLabelStyle}>
          このモニタ
        </h2>
        {/* 主導線は実寸サイネージプレビュー（アプリ内・#1257）: スマホでも 16:9 実寸比・任意日も見られる。
            現在編集中の日付を引き継ぎ、編集を失わないよう別タブで開く。 */}
        <p style={{ display: "flex", gap: "1rem", flexWrap: "wrap", margin: "0 0 0.75rem" }}>
          <Link
            href={editorPreviewPath(classId, date)}
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: "0.9rem", fontWeight: 600, color: tokens.color.primaryHover }}
          >
            サイネージのプレビューを開く →
          </Link>
          {/* 副次導線: TV が実際に開いている公開サイネージサイト（tv_devices.signage_url）。別 host/別 origin に
              なりうる絶対 URL なので素の <a>（prefetch 回避）。未設置クラスは出さない（死リンク防止）。 */}
          {liveSignageUrl ? (
            <a
              href={liveSignageUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontSize: "0.85rem", color: tokens.color.muted }}
            >
              実機の画面を開く ↗
            </a>
          ) : null}
        </p>
        {/* 広告管理 / 静粛時間は school_admin の per-class 管理導線（端末系＝このモニタへ集約・§3.1）。
            teacher には出さない（死リンク防止）。 */}
        {canManageAds || canManageQuietHours ? (
          <p style={{ display: "flex", gap: "1rem", flexWrap: "wrap", margin: "0 0 0.75rem" }}>
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
        {/* 黒画面トグル（per-class 運用）。実教室のサイネージを一時的に真っ黒にする / 解除する。
            実画面に即時影響するので押下時に確認を挟む（BlackoutToggle 側）。 */}
        <section aria-labelledby="blackout-heading" style={blackoutSectionStyle}>
          <h3 id="blackout-heading" style={blackoutHeadingStyle}>
            サイネージを黒画面にする
          </h3>
          <BlackoutToggle classId={classId} initialBlackout={board?.blackout ?? false} />
        </section>
      </section>

      <RememberLastClass classId={classId} />

      {/* AI は右下に浮く支援チャット。FAB → パネルで開閉。会話・保存・SSE は EditorChat が温存。対象日に追随する。
          key: 対象日変更で再マウントし新日付の下書きで初期化する（key 無しだと旧日付の中身が残り保存で混線する）。
          copied（前日/前週コピーの nonce）も含める＝コピー直後に AI の下書きシードがコピー前の盤面のまま残り、
          AI 経由の反映でコピー結果を巻き戻す穴を塞ぐ（各エディタ key と同じ理由・設計書 §11-1）。
          **applied はここには含めない**（反映後も会話・パネル状態を保つ。チャット自身の差分基準は onApply 内で
          更新済み・フォーム側の key にだけ含めて再マウントする）。 */}
      <FloatingAiChat>
        <ClassEditorChat
          key={`${date}:${copied}`}
          classId={classId}
          date={date}
          assignmentDeadlineFormat={deadlineFormat}
          // 歓迎文をこのクラスの実効パターンの実セクションで合成する（§6.4・v2-ed47-5 の根治）。許可セクション
          // 自体はサーバ（chat route）が別途解決＝この prop は表示文言のみ。
          pattern={pattern}
          initialDraft={{
            // 盤面エディタと同じ seed 済み初期値（F5）。AI の下書きが seed を知らないと、per-section 置換保存で
            // seed 内容を消しうるため一致させる（設計書 §11-6）。
            schedules: seed.items,
            notices: notices.items,
            assignments: assignments.items,
          }}
          // 固定行（pinned）の保全（MEDIUM-3）: AI の per-date 置換保存が保存先日付の「ずっと」を消さない
          // よう、クラス直の固定行を渡す（EditorChat が反映時に preservePinnedNotices で前置き合流させる）。
          pinnedNotices={pinnedNotices}
        />
      </FloatingAiChat>
    </EditorDraftSyncProvider>
  );
}

// ゾーン見出し（毎日の編集 / 計画 / このモニタ）。小さく太く muted で「層のラベル」として出す（主役は中身）。
const zoneLabelStyle: React.CSSProperties = {
  fontSize: tokens.fontSize.xs,
  fontWeight: 700,
  color: tokens.color.muted,
  letterSpacing: "0.08em",
  margin: "0 0 0.6rem",
};
// ゾーン2/3 の区切り（上枠線 + 余白）。カード化はせず罫線で層を分ける（盤面/フォームの視覚ノイズを増やさない）。
const zoneSectionStyle: React.CSSProperties = {
  marginTop: "2rem",
  paddingTop: "1.25rem",
  borderTop: `1px solid ${tokens.color.border}`,
};
// 黒画面トグル節（このモニタ ゾーン内）。見出し + トグル + 説明をまとめる枠。
const blackoutSectionStyle: React.CSSProperties = {
  marginTop: "1rem",
  paddingTop: "1rem",
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
  marginBottom: "0.5rem",
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

// 「編集中: ◯月◯日」の見出し（対象日の明示・受入基準 PR-A-1・選択の強調はセグメント側が担う）。遠い日をカレンダーで
// 選ぶとタブに無いのでこれが唯一の日付表示になるため残すが、引き算 2026-07-05（user「ヘッダーが領域を取りすぎ」）で
// 小さめ・余白最小にして縦を節約する。
const editingHeadingStyle: React.CSSProperties = {
  fontSize: tokens.fontSize.sm,
  fontWeight: 600,
  color: tokens.color.ink,
  margin: "0.25rem 0 0",
};
// sr-only（視覚的に隠すがスクリーンリーダ・aria-labelledby には残す）。「毎日の編集」節ラベルを画面から消して
// 縦を節約する用（引き算 2026-07-05）。値は一般的な visually-hidden 定義。
const srOnlyStyle: React.CSSProperties = {
  position: "absolute",
  width: "1px",
  height: "1px",
  padding: 0,
  margin: "-1px",
  overflow: "hidden",
  clipPath: "inset(50%)",
  whiteSpace: "nowrap",
  border: 0,
};
// 基本時間割からの seed 注記（F5・コピーオンライト）。控えめな補足テキスト（既存の xs/muted と同じ視覚言語）。
const seedNoteStyle: React.CSSProperties = {
  fontSize: tokens.fontSize.xs,
  color: tokens.color.muted,
  margin: "0 0 0.5rem",
};
