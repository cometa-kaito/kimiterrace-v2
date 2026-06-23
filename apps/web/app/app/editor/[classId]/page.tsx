import { EditorChat } from "@/app/app/editor/_components/EditorChat";
import { isRoleAllowed, requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { getClassContentDates, monthWindow } from "@/lib/editor/content-dates";
import type { EditorBoardBase } from "@/lib/editor/editor-board-preview";
import { getClassAssignments, getClassNotices } from "@/lib/editor/notice-assignment-queries";
import { EDITOR_ROLES, isValidDate } from "@/lib/editor/schedule-core";
import { getClassSchedule } from "@/lib/editor/schedule-queries";
import { ADS_ROLES } from "@/lib/school-admin/ads-core";
import { QUIET_HOURS_ROLES } from "@/lib/school-admin/quiet-hours-core";
import { resolveDesignPattern } from "@/lib/signage/design-pattern";
import { patternIncludesBlock } from "@/lib/signage/pattern-blocks";
import { getSignageDesignPattern } from "@/lib/signage/signage-design";
import { buildSignagePayloadForClass } from "@/lib/signage/signage-display";
import { getClassSignageUrl } from "@kimiterrace/db";
import { tokens } from "@kimiterrace/ui";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BlackoutToggle } from "./_components/BlackoutToggle";
import { EditorDateCalendar } from "./_components/EditorDateCalendar";
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
  searchParams: Promise<{ date?: string; plan?: string }>;
}) {
  const user = await requireRole(EDITOR_ROLES);
  const { classId } = await params;
  // 広告管理 / 静粛時間は school_admin / system_admin 専任。teacher には出さない（死リンク防止）。
  const canManageAds = isRoleAllowed(user.role, ADS_ROLES);
  const canManageQuietHours = isRoleAllowed(user.role, QUIET_HOURS_ROLES);
  const { date: dateParam, plan: planParam } = await searchParams;
  // 上＝「今日の編集」: 既定は JST 今日。?date= の明示指定があればそれを上に出す（互換・通常は未使用）。
  const today = new Date().toLocaleDateString("en-CA", { timeZone: JST });
  const date = dateParam && isValidDate(dateParam) ? dateParam : today;
  // 下＝「選択した日の編集」: カレンダーで選んだ先の日（?plan=）。上と同じ日なら下は出さない（重複回避）。
  const planValid = planParam && isValidDate(planParam) ? planParam : null;
  const plan = planValid && planValid !== date ? planValid : null;

  const data = await withSession(async (tx) => {
    const schedule = await getClassSchedule(tx, classId, date);
    if (!schedule) {
      return null;
    }
    // 編集フォームの初期値は**クラス直の**当日セクション（編集対象＝raw）。盤面プレビューの基底（下記 `board`）は
    // class>grade>dept>school のマージ結果なので、編集フォーム用にはこちらを別途引く（用途が違う）。
    const notices = await getClassNotices(tx, classId, date);
    const assignments = await getClassAssignments(tx, classId, date);
    // 「このクラスのサイネージを開く」導線兼**端末別デザインパターン解決**用に、当該クラスの TV デバイスの公開
    // サイネージ URL を引く（同一 tx・RLS 自校限定）。未設置クラスは undefined → リンクを出さない（死リンク防止）。
    const liveSignageUrl = await getClassSignageUrl(tx, classId);
    // サイネージデザインパターンを解決（**端末別 `?design` > 学校レベル既定 > pattern1**）。実機 TV / モニタの壁と
    // 同じ優先順位（`resolveDesignPattern` 単一ソース）で、このクラスの実機が実際に出すパターンでプレビュー・編集
    // セクションを出し分ける（学校既定が pattern1 でも端末が pattern2/3/4 なら追従＝旧「学校既定のみ参照」を是正）。
    const pattern = resolveDesignPattern(liveSignageUrl, await getSignageDesignPattern(tx));
    // WYSIWYG（盤面を編集タブ）のライブプレビュー基底は、**実機サイネージと完全に同一の payload builder**
    // （`buildSignagePayloadForClass`）から組む。これにより自動コンテンツ系ブロック（時事ニュース / 鉄道 /
    // 人感センサ / 防災・安全帯）も実機と同じ取得ゲート（`PATTERN_BLOCKS`）・同じ fail-soft で取得・描画され、
    // エディタの盤面と実機 TV の見た目が一致する。旧実装は base を手組みして自動ブロックを `null` 固定していたため
    // pattern2/3/4 でニュース等が空欄になり「エディタのパターンと実機の表示が合わない」ズレが出ていた（本修正の主眼・
    // ユーザー報告 2026-06-20）。`pattern` を designParam として渡すので builder 内の二重パターン解決は起きない。
    // schoolId 不明時は null（盤面を出さず WysiwygBoardEditor が従来の縦積みフォームへ fail-soft フォールバック）。
    const board = user.schoolId
      ? await buildSignagePayloadForClass(tx, user.schoolId, classId, date, pattern)
      : null;
    // 来校者一覧 / 生徒呼び出しは `PATTERN_BLOCKS` 上 pattern2/3 専用の**編集対象**ブロック。盤面下の編集欄を
    // 出すかの判定に使う（実機と同じ取得結果は `board.visitors` / `board.callouts` に載る）。`patternIncludesBlock`
    // 単一ソース駆動で `=== "pattern2"` のハードコード分岐を作らない（将来パターン追加に自動追従）。
    const showVisitors = patternIncludesBlock(pattern, "visitor");
    const showCallouts = patternIncludesBlock(pattern, "callout");
    // カレンダー（内容ドット）用: 表示しそうな月（選択日があればその月・無ければ今日の月）±1 か月を自校 RLS 内で引く。
    const calWindow = monthWindow(plan ?? date);
    const contentDates = await getClassContentDates(tx, classId, calWindow.start, calWindow.end);
    // 下＝「選択した日の編集」用: ?plan の日のデータを同 tx で取得（無選択 or 取得不能なら null）。盤面は描かない
    // （showBoard=false）が、パターン別の出し分けと来校者/呼び出しデータのため board は今日と対称に組む
    // （データ経路を分岐させない＝バグ源を増やさない）。
    let planData: {
      schedule: NonNullable<Awaited<ReturnType<typeof getClassSchedule>>>;
      notices: NonNullable<Awaited<ReturnType<typeof getClassNotices>>>;
      assignments: NonNullable<Awaited<ReturnType<typeof getClassAssignments>>>;
      board: Awaited<ReturnType<typeof buildSignagePayloadForClass>> | null;
    } | null = null;
    if (plan) {
      const pSchedule = await getClassSchedule(tx, classId, plan);
      const pNotices = await getClassNotices(tx, classId, plan);
      const pAssignments = await getClassAssignments(tx, classId, plan);
      if (pSchedule && pNotices && pAssignments) {
        const pBoard = user.schoolId
          ? await buildSignagePayloadForClass(tx, user.schoolId, classId, plan, pattern)
          : null;
        planData = {
          schedule: pSchedule,
          notices: pNotices,
          assignments: pAssignments,
          board: pBoard,
        };
      }
    }
    return {
      schedule,
      notices,
      assignments,
      showVisitors,
      showCallouts,
      board,
      liveSignageUrl,
      contentDates,
      planData,
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
    board,
    liveSignageUrl,
    contentDates,
    planData,
  } = data;

  // WYSIWYG（盤面を編集タブ）のライブプレビュー基底スナップショット。`board` は実機 `buildSignagePayloadForClass`
  // の出力（`SignagePayload`）で、`EditorBoardBase` はその表示用フィールドの `Pick` なのでそのまま渡せる。盤面は
  // このクラスの実機が出すパターン（`board.designPattern`＝端末別 `?design` 解決済み）の `PATTERN_BLOCKS` レイアウトで
  // 描かれ、予定 / 連絡 / 提出物 / 来校者 / 呼び出しに加え、自動コンテンツ（ニュース / 鉄道 / 人感センサ / 防災帯）も
  // **実機とまったく同じデータ**で出る（編集連動は予定/連絡/提出物のみ・来校者/呼び出しの編集欄は盤面下に出す）。
  // 取得不能（クラス不可視 / schoolId 不明）は `null` で、WysiwygBoardEditor が盤面を畳んで従来フォームのみに
  // フォールバックする（盤面を壊さない・編集は引き続き可能）。
  const boardBase: EditorBoardBase | null = board;

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
      {/* 上＝「今日の編集」。常にここ（先の日の選択では動かさない）・盤面プレビュー付き（要望 2026-06-23）。 */}
      <p style={todayHeadingStyle}>今日の編集 — {jpDate(today)}</p>
      <WysiwygBoardEditor
        key={date}
        classId={classId}
        date={date}
        base={boardBase}
        initialSchedules={schedule.items}
        initialNotices={notices.items}
        initialAssignments={assignments.items}
      />

      {/* 来校者 / 呼び出しは pattern2/3 のブロック（`PATTERN_BLOCKS` 駆動・`patternIncludesBlock`）。含む
          パターンのときだけ 2 カラムで盤面の下に出す（含まないパターンでは盤面に出ないので編集セクションも
          出さない＝死セクション防止・finding①。将来パターン追加にも単一ソースで自動追従）。
          各エディタの key は VisitorsCalloutsSection 内で衝突しない安定キー（visitors-* / callouts-*）にして
          いる。旧実装は両方を同じ key={date} で、条件付き短絡（showVisitors && … / showCallouts && …）のまま
          同一親に隣接させており、対象日変更（?date= ソフトナビ＝同一ページ再レンダ）時に「来校者一覧」複製・
          「生徒呼び出し」が下へ押し出される実バグが観測された（本番 6/21→6/22 再現）。日付変更で再マウントし
          新日付データで初期化する意図は key に date を含めて維持する。詳細・観測条件は VisitorsCalloutsSection
          の docstring 参照。盤面のパターン選択（showVisitors / showCallouts）は親で決めた値をそのまま渡すだけで
          増減させない。 */}
      <VisitorsCalloutsSection
        classId={classId}
        date={date}
        showVisitors={showVisitors}
        showCallouts={showCallouts}
        visitors={board?.visitors ?? null}
        callouts={board?.callouts ?? null}
      />

      {/* 中＝カレンダー。先の日付を選ぶと下の「選択した日の編集」に入る（?plan= ルーティング・上の今日は動かさない）。
          内容のある日は点で俯瞰（要望 2026-06-23: 今日と未来を完全に別セクションに分ける）。 */}
      <EditorDateCalendar
        classId={classId}
        today={today}
        selectedDate={plan ?? undefined}
        contentDates={contentDates}
      />

      {/* 下＝「選択した日の編集」。?plan の先の日をフォームのみ（盤面なし＝showBoard=false）で編集する。データ経路・
          保存・検証・RLS は今日と同じ部品を date=plan で再利用（key={plan} で日付ごとに初期化）。来校者/呼び出しも
          pattern2/3 なら同様に出す。plan 未選択 or その日が取得不能なら出さない。 */}
      {plan && planData ? (
        <section aria-label={`選択した日の編集 ${jpDate(plan)}`}>
          <p style={futureHeadingStyle}>選択した日の編集 — {jpDate(plan)}</p>
          <WysiwygBoardEditor
            key={plan}
            showBoard={false}
            classId={classId}
            date={plan}
            base={planData.board}
            initialSchedules={planData.schedule.items}
            initialNotices={planData.notices.items}
            initialAssignments={planData.assignments.items}
          />
          <VisitorsCalloutsSection
            classId={classId}
            date={plan}
            showVisitors={showVisitors}
            showCallouts={showCallouts}
            visitors={planData.board?.visitors ?? null}
            callouts={planData.board?.callouts ?? null}
          />
        </section>
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
        <BlackoutToggle classId={classId} initialBlackout={board?.blackout ?? false} />
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

// 「今日の編集」/「選択した日の編集」のセクション見出し（色で 今日=青 / 未来=橙 に分け、視覚的に別物だと示す）。
const todayHeadingStyle: React.CSSProperties = {
  fontSize: tokens.fontSize.md,
  fontWeight: 600,
  color: tokens.color.blueStrong,
  margin: "0.5rem 0 0.7rem",
};
const futureHeadingStyle: React.CSSProperties = {
  fontSize: tokens.fontSize.md,
  fontWeight: 600,
  color: tokens.color.primaryHover,
  margin: "1.5rem 0 0.7rem",
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
