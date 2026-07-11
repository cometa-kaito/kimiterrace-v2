import type { AssignmentItem, NoticeItem } from "@/lib/editor/notice-assignment-core";
import type { ScheduleItem } from "@/lib/editor/schedule-core";
import type { EffectiveDailyData, ScheduleDay } from "@/lib/signage/effective-daily-data";
import type { SignagePayload } from "@/lib/signage/signage-display";

/**
 * WYSIWYG エディタ（実レイアウト上のライブプレビュー）の **データブリッジ**（純粋関数）。
 *
 * クラスエディタの「盤面を編集」タブは、教員が**実際のサイネージ配置（{@link SignageBoardView} / 50 インチ
 * TV と同一レイアウト）の上で編集している様子をその場で見られる**ように、編集中の下書き（予定 / 連絡 / 提出物）を
 * サイネージ盤面に重ねて描く。本モジュールは、サーバが取得した「基底スナップショット」（実効データ・広告・天気・
 * クラス文脈・デザインパターン・黒画面）に、**クライアントで編集中の当日セクション**を上書きして
 * {@link SignagePayload} を組み立てる。
 *
 * ## なぜ純粋関数か
 * `SignageBoardView`（盤面描画層）は `SignagePayload` を受け取る。盤面の見た目・配色・領域配置を**実機と完全一致**
 * させるため（重複実装しない）、エディタは盤面 component を再実装せず「ライブな payload を作って渡す」だけにする。
 * その payload 合成を DB 非依存の純関数に閉じ込め、node 環境で決定的に unit テストできるようにする。
 *
 * ## 上書き規約（編集中＝当日のみ）
 * エディタは**対象日 1 日分**の予定 / 連絡 / 提出物を編集する。サイネージの「予定」は今後 3 平日の 3 列だが、
 * 編集できるのは当日列だけなので、`scheduleDays` のうち `date` と一致する列だけ編集中 items に差し替え、他日付
 * （明日以降）は基底スナップショットのまま残す。連絡 / 提出物は当日分のみ盤面に出る（{@link EffectiveDailyData}）ので
 * そのまま編集中 items に差し替える。
 *
 * **保存ロジックとは独立**: ここは表示用 payload の合成のみ。実際の保存・検証・RLS・監査は各セクションの Server
 * Action が担う（本モジュールは一切 DB に触れない）。編集中 items は「保存ペイロード相当」だが、検証前の生値が
 * 来てもサイネージ整形（`section-format.ts`）が fail-soft で受け止めるので盤面は壊れない。
 */

/** エディタが編集中の 1 日分の下書き（保存ペイロード相当）。 */
export type EditorBoardDraft = {
  schedules: ScheduleItem[];
  notices: NoticeItem[];
  assignments: AssignmentItem[];
};

/**
 * 他日入力の「持ち越し」項目（対象日に活性な 非 pinned 連絡=表示日数>1・提出物=期限+猶予）。実 TV は
 * 窓マージ（effective-daily-data）で表示しているため、これをプレビューにも合成しないと「実機には出ている
 * 提出物がプレビューでは消えている」過少表示になる（2026-07-06 実画面監査で実証: 7/7 入力の〆切 7/10 が
 * 7/8 のプレビューで不可視）。抽出は activeCarryoverItemsOutsideDate（単一ソース）が担う。
 */
export type EditorBoardCarryover = {
  notices: readonly NoticeItem[];
  assignments: readonly AssignmentItem[];
};

/** 持ち越し無し（既定・後方互換）。 */
const EMPTY_CARRYOVER: EditorBoardCarryover = { notices: [], assignments: [] };

/**
 * 盤面プレビューの「基底スナップショット」。サーバ（RLS 文脈内）で取得した確定データをそのまま渡す。
 * `SignagePayload` のうち、エディタが上書きする `daily` / `scheduleDays` 以外の表示用フィールドを内包する。
 */
export type EditorBoardBase = Pick<
  SignagePayload,
  | "date"
  | "designPattern"
  | "assignmentDeadlineFormat"
  | "daily"
  | "scheduleDays"
  | "ads"
  | "weather"
  | "classContext"
  | "presenceCount"
  | "visitors"
  | "callouts"
  | "trainStatus"
  | "news"
  | "weatherWarnings"
  | "heatAlerts"
  | "blackout"
>;

/**
 * 基底スナップショット + 編集中の当日下書きから、ライブプレビュー用の {@link SignagePayload} を組み立てる。
 *
 * - `daily.schedules` / `daily.notices` / `daily.assignments` を編集中 items に差し替える（source は `class`＝
 *   クラス由来の編集として扱う。継承バッジを出さない）。`quietHours` は編集対象外なので基底のまま。
 * - `scheduleDays` は当日列（`date` 一致）だけ編集中 schedules に差し替え、他日付は基底のまま残す。
 * - `pinnedNotices`（**対象日以外**の日に入力された・対象日に活性な固定行＝サーバで
 *   {@link "@/lib/signage/effective-daily-data".activePinnedNoticeItemsOutsideDate} が単一ソース
 *   `isNoticeActive` で抽出・入力日昇順）を編集中 notices の**前に連結**する（2026-07-04 Reviewer MEDIUM-2）。
 *   実 TV は窓マージ（入力日昇順・対象日の行が末尾）で他日入力の pinned を出しているため、これが無いと
 *   「実機には校訓が出ている／プレビューには出ない」の恒常不一致になる（WYSIWYG の存在意義に反する）。
 *   対象日の pinned は draft 自体（NoticeEditor の「ずっと」行）に含まれるのでここでは足さない。
 *
 * 基底の他フィールド（広告・天気・クラス文脈・パターン2 専用ブロック・黒画面）は編集対象外なのでそのまま通す。
 */
export function buildEditorPreviewPayload(
  base: EditorBoardBase,
  draft: EditorBoardDraft,
  pinnedNotices: readonly NoticeItem[] = [],
  carryover: EditorBoardCarryover = EMPTY_CARRYOVER,
): SignagePayload {
  // 提出物は「他日入力の持ち越し（期限+猶予まで活性）＋対象日の編集中 items」を実盤面と同じ**期限昇順**に
  // 揃える（mergeWindowedSection と同型・2026-07-06 忠実度）。編集中の未確定行（deadline 空）は末尾側に寄る
  // （空文字は辞書順で先頭になるため明示的に末尾へ）。
  const assignments = [...carryover.assignments, ...draft.assignments].sort((a, b) => {
    const da = typeof a.deadline === "string" && a.deadline !== "" ? a.deadline : "9999-99-99";
    const db = typeof b.deadline === "string" && b.deadline !== "" ? b.deadline : "9999-99-99";
    return da < db ? -1 : da > db ? 1 : 0;
  });
  const daily: EffectiveDailyData = {
    ...base.daily,
    // 編集中の当日セクションで上書き（クラス由来＝source: "class"。継承バッジは出さない）。
    // notices は「他日入力の活性 pinned → 他日入力の活性持ち越し（表示日数>1・入力日昇順）→ 対象日の編集中
    // items」の順で実盤面のマージ順（入力日昇順・対象日が末尾）に揃える。
    schedules: { items: draft.schedules, source: "class" },
    notices: { items: [...pinnedNotices, ...carryover.notices, ...draft.notices], source: "class" },
    assignments: { items: assignments, source: "class" },
  };

  const scheduleDays: ScheduleDay[] = base.scheduleDays.map((day) =>
    day.date === base.date
      ? { date: day.date, schedule: { items: draft.schedules, source: "class" } }
      : day,
  );

  return {
    date: base.date,
    designPattern: base.designPattern,
    assignmentDeadlineFormat: base.assignmentDeadlineFormat,
    daily,
    scheduleDays,
    ads: base.ads,
    weather: base.weather,
    classContext: base.classContext,
    presenceCount: base.presenceCount,
    visitors: base.visitors,
    callouts: base.callouts,
    trainStatus: base.trainStatus,
    news: base.news,
    weatherWarnings: base.weatherWarnings,
    heatAlerts: base.heatAlerts,
    blackout: base.blackout,
  };
}
