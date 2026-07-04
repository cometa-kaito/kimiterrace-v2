import { EditorChat } from "@/app/app/editor/_components/EditorChat";
import { isRoleAllowed, requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { getClassContentDates, monthWindow } from "@/lib/editor/content-dates";
import {
  editorDateSegments,
  parseEditorDayCutover,
  planRedirectPath,
  resolveDefaultEditorDate,
} from "@/lib/editor/default-date";
import type { EditorBoardBase } from "@/lib/editor/editor-board-preview";
import {
  getClassAssignments,
  getClassNotices,
  getClassPinnedNoticeRows,
} from "@/lib/editor/notice-assignment-queries";
import { EDITOR_ROLES, isValidDate } from "@/lib/editor/schedule-core";
import { getClassSchedule } from "@/lib/editor/schedule-queries";
import { seedSchedulesForDate } from "@/lib/editor/weekly-timetable-core";
import { getClassWeeklyTimetable } from "@/lib/editor/weekly-timetable-queries";
import { ADS_ROLES } from "@/lib/school-admin/ads-core";
import { QUIET_HOURS_ROLES } from "@/lib/school-admin/quiet-hours-core";
import { parseSignageDesignPattern, resolveDesignPattern } from "@/lib/signage/design-pattern";
import { activePinnedNoticeItemsOutsideDate } from "@/lib/signage/effective-daily-data";
import { patternIncludesBlock, scheduleInputVariant } from "@/lib/signage/pattern-blocks";
import { jstDateString } from "@/lib/signage/rotation";
import { buildSignagePayloadForClass } from "@/lib/signage/signage-display";
import { getClassSignageUrl, getSchoolConfigValue } from "@kimiterrace/db";
import { tokens } from "@kimiterrace/ui";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { BlackoutToggle } from "./_components/BlackoutToggle";
import { CopyPreviousDayButton } from "./_components/CopyPreviousDayButton";
import { CopyPreviousWeekButton } from "./_components/CopyPreviousWeekButton";
import { EditorDateCalendar } from "./_components/EditorDateCalendar";
import { EditorDateSegments } from "./_components/EditorDateSegments";
import { FloatingAiChat } from "./_components/FloatingAiChat";
import { RememberLastClass } from "./_components/RememberLastClass";
import { VisitorsCalloutsSection } from "./_components/VisitorsCalloutsSection";
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
 * される混線バグが再発する・2026-06-16 実バグ）。
 */
export default async function ClassEditorPage({
  params,
  searchParams,
}: {
  params: Promise<{ classId: string }>;
  searchParams: Promise<{ date?: string; plan?: string; copied?: string }>;
}) {
  const user = await requireRole(EDITOR_ROLES);
  const { classId } = await params;
  // 広告管理 / 静粛時間は school_admin / system_admin 専任。teacher には出さない（死リンク防止）。
  const canManageAds = isRoleAllowed(user.role, ADS_ROLES);
  const canManageQuietHours = isRoleAllowed(user.role, QUIET_HOURS_ROLES);
  const { date: dateParam, plan: planParam, copied: copiedParam } = await searchParams;
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
  const now = new Date();
  const today = jstDateString(now);
  // `?date=` 明示は常に優先（deep link 安定）。無指定の既定は school_configs の cutover を読んでから
  // tx 内で決める（下記）。
  const requestedDate = dateParam && isValidDate(dateParam) ? dateParam : null;

  const data = await withSession(async (tx) => {
    // display_settings（opaque JSONB）は 1 回だけ読み、既定対象日の cutover（editorDayCutover・§3.2）と
    // 学校レベル既定デザイン（signageDesign）の両方をここから defensive にパースする。
    const displaySettings = await getSchoolConfigValue(tx, "display_settings");
    const date =
      requestedDate ?? resolveDefaultEditorDate(now, parseEditorDayCutover(displaySettings));
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
    // 週次ベース時間割（F5・コピーオンライト）: 対象日の予定が空のとき、その曜日の基本時間割をエディタの初期値に
    // seed するために引く（自校 RLS・同一 tx）。テンプレ未登録は空。盤面の表示時マージはしない（seed は編集初期値のみ）。
    const weeklyTimetable = (await getClassWeeklyTimetable(tx, classId))?.timetable ?? {};
    // 「このクラスのサイネージを開く」導線兼**端末別デザインパターン解決**用に、当該クラスの TV デバイスの公開
    // サイネージ URL を引く（同一 tx・RLS 自校限定）。未設置クラスは undefined → リンクを出さない（死リンク防止）。
    const liveSignageUrl = await getClassSignageUrl(tx, classId);
    // サイネージデザインパターンを解決（**端末別 `?design` > 学校レベル既定 > pattern1**）。実機 TV / モニタの壁と
    // 同じ優先順位（`resolveDesignPattern` 単一ソース）で、このクラスの実機が実際に出すパターンでプレビュー・編集
    // セクションを出し分ける（学校既定が pattern1 でも端末が pattern2/3/4 なら追従＝旧「学校既定のみ参照」を是正）。
    const pattern = resolveDesignPattern(
      liveSignageUrl,
      parseSignageDesignPattern(displaySettings),
    );
    // WYSIWYG（盤面を編集タブ）のライブプレビュー基底は、**実機サイネージと完全に同一の payload builder**
    // （`buildSignagePayloadForClass`）から組む。これにより自動コンテンツ系ブロック（時事ニュース / 鉄道 /
    // 人感センサ / 防災・安全帯）も実機と同じ取得ゲート（`PATTERN_BLOCKS`）・同じ fail-soft で取得・描画され、
    // エディタの盤面と実機 TV の見た目が一致する。`pattern` を designParam として渡すので builder 内の二重パターン
    // 解決は起きない。schoolId 不明時は null（盤面を出さず WysiwygBoardEditor が従来の縦積みフォームへ fail-soft
    // フォールバック）。
    const board = user.schoolId
      ? await buildSignagePayloadForClass(tx, user.schoolId, classId, date, pattern)
      : null;
    // 来校者一覧 / 生徒呼び出しは `PATTERN_BLOCKS` 上 pattern2/3 専用の**編集対象**ブロック。盤面下の編集欄を
    // 出すかの判定に使う（実機と同じ取得結果は `board.visitors` / `board.callouts` に載る）。`patternIncludesBlock`
    // 単一ソース駆動で `=== "pattern2"` のハードコード分岐を作らない（将来パターン追加に自動追従）。
    const showVisitors = patternIncludesBlock(pattern, "visitor");
    const showCallouts = patternIncludesBlock(pattern, "callout");
    // カレンダー（内容ドット）用: 対象日の月±1 か月を自校 RLS 内で引く。
    const calWindow = monthWindow(date);
    const contentDates = await getClassContentDates(tx, classId, calWindow.start, calWindow.end);
    return {
      date,
      schedule,
      notices,
      assignments,
      pinnedNotices,
      pattern,
      showVisitors,
      showCallouts,
      board,
      liveSignageUrl,
      contentDates,
      weeklyTimetable,
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
    showVisitors,
    showCallouts,
    board,
    liveSignageUrl,
    contentDates,
    weeklyTimetable,
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

  return (
    <>
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
          編集スタックは常に 1 つで、セグメント切替（?date= ソフトナビ）で全体がその日に追随する。 */}
      <section aria-labelledby="zone-daily-heading">
        <h2 id="zone-daily-heading" style={zoneLabelStyle}>
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
          編集中: {jpDate(date)}
          {date === today ? "（今日）" : ""}
        </p>
        {/* 基本時間割からの seed 注記（F5）: seed が効いている日だけ小さく出す（保存して初めて確定＝daily_data へ
            materialize されることを伝える）。 */}
        {seed.seeded ? <p style={seedNoteStyle}>基本時間割から反映（保存すると確定）</p> : null}
        {/* key={date}:{copied}: 対象日変更・コピー時に再マウントして新データで初期化する。これが無いと配下エディタの
            useState(initial...) が再初期化されず、旧日付の入力が残ったまま保存され「中身が変更先の日付に移る」
            混線バグになる（ユーザー報告 2026-06-16・設計書 §11-1）。 */}
        <WysiwygBoardEditor
          key={`${date}:${copied}`}
          classId={classId}
          date={date}
          base={boardBase}
          initialSchedules={seed.items}
          initialNotices={notices.items}
          initialAssignments={assignments.items}
          pinnedNotices={pinnedNotices}
          previewPinnedNotices={previewPinnedNotices}
        />
        {/* 来校者 / 呼び出しは pattern2/3 のブロック（`PATTERN_BLOCKS` 駆動・`patternIncludesBlock`）。含む
            パターンのときだけ盤面の下に出す（死セクション防止・将来パターン追加にも単一ソースで自動追従）。
            対象日ソフトナビ（?date=）時の複製/押し出しバグの前例（本番 6/21→6/22）があるため、条件付き短絡で
            同一親に隣接させず常に単一の安定コンポーネントとして描く（設計書 §11-2・詳細は
            VisitorsCalloutsSection の docstring）。 */}
        <VisitorsCalloutsSection
          classId={classId}
          date={date}
          pattern={pattern}
          showVisitors={showVisitors}
          showCallouts={showCallouts}
          visitors={board?.visitors ?? null}
          callouts={board?.callouts ?? null}
        />
      </section>

      {/* ─ ゾーン2: 計画（§3.1）─ 前日コピー / 前週コピー / 基本時間割 / 月カレンダー。日常編集と視覚的に分ける。 */}
      <section aria-labelledby="zone-plan-heading" style={zoneSectionStyle}>
        <h2 id="zone-plan-heading" style={zoneLabelStyle}>
          計画
        </h2>
        {/* 前日コピー（F3）: 前営業日の予定/連絡/提出物を**編集中の対象日**へ複製する（対象日に追随・§3.1）。
            既存入力があれば上書き確認（ボタン側）。成功時の ?copied= 再ナビは現在の ?date= を保持する
            （URLSearchParams 引き継ぎ・ボタン側実装）。 */}
        <div style={planRowStyle}>
          <CopyPreviousDayButton
            classId={classId}
            date={date}
            hasExistingData={
              schedule.items.length > 0 || notices.items.length > 0 || assignments.items.length > 0
            }
          />
        </div>
        {/* 前週コピー（C2）: 「JST 今日を含む週」固定の一括複製（選択日基準ではない・§3.3 で据え置き）。 */}
        <div style={planRowStyle}>
          <CopyPreviousWeekButton classId={classId} />
        </div>
        {/* 週次ベース時間割（F5・セカンド層）への導線。計画系の操作なのでカレンダーとセットで置く。
            時限ベースの予定を持つパターンのみ（掲示板型 pattern5 は時刻入力＝時限テンプレが馴染まない、
            pattern4 は予定自体が無い＝いずれも死リンク/死導線防止・§6.2）。 */}
        {periodSchedule ? (
          <p style={planRowStyle}>
            <Link href={`/app/editor/${classId}/timetable`} style={{ fontSize: "0.9rem" }}>
              基本時間割を設定 →
            </Link>
          </p>
        ) : null}
        {/* 月カレンダー: 対象日そのものを選ぶ（?date= 一本化・旧 ?plan の第 2 スタックは廃止）。セグメントの
            「📅 ほかの日」がここへスクロールして開く。 */}
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
        {/* TV が実際に表示している**公開サイネージサイト**（tv_devices.signage_url = /signage/{token}）を開く。
            Next アプリ内ルートだが別 host/別 origin になりうる絶対 URL なので素の <a> で開く（client-side
            prefetch を避ける）。編集を失わないよう別タブで開く（rel=noopener）。設置 TV が無いクラスは
            liveSignageUrl が undefined → リンク自体を出さない（死リンク防止）。 */}
        {liveSignageUrl ? (
          <p style={{ margin: "0 0 0.75rem" }}>
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
          AI 経由の反映でコピー結果を巻き戻す穴を塞ぐ（各エディタ key と同じ理由・設計書 §11-1）。 */}
      <FloatingAiChat>
        <EditorChat
          key={`${date}:${copied}`}
          scope="class"
          targetId={classId}
          date={date}
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
          variant="floating"
        />
      </FloatingAiChat>
    </>
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
// 計画ゾーン内の操作行（コピー系ボタン・リンク）。
const planRowStyle: React.CSSProperties = {
  margin: "0 0 0.75rem",
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

// 「編集中: ◯月◯日」の見出し（対象日の明示・受入基準 PR-A-1）。今日/未来で色を変えない（対象日は 1 つ＝
// 旧 2 スタックの青/橙の使い分けは廃止。選択の強調はセグメント側が担う）。
const editingHeadingStyle: React.CSSProperties = {
  fontSize: tokens.fontSize.md,
  fontWeight: 600,
  color: tokens.color.ink,
  margin: "0 0 0.7rem",
};
// 基本時間割からの seed 注記（F5・コピーオンライト）。控えめな補足テキスト（既存の xs/muted と同じ視覚言語）。
const seedNoteStyle: React.CSSProperties = {
  fontSize: tokens.fontSize.xs,
  color: tokens.color.muted,
  margin: "0 0 0.5rem",
};

// 編集中の日付の和暦風ラベル（"2026年6月23日（火）"）。曜日は日付から決まり today 非依存＝SSR/CSR 一致。
const WEEKDAY_JP = ["日", "月", "火", "水", "木", "金", "土"];
function jpDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) {
    return date;
  }
  const weekday = WEEKDAY_JP[new Date(y, m - 1, d).getDay()] ?? "";
  return `${y}年${m}月${d}日（${weekday}）`;
}
