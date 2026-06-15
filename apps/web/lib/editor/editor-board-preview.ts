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
 * 盤面プレビューの「基底スナップショット」。サーバ（RLS 文脈内）で取得した確定データをそのまま渡す。
 * `SignagePayload` のうち、エディタが上書きする `daily` / `scheduleDays` 以外の表示用フィールドを内包する。
 */
export type EditorBoardBase = Pick<
  SignagePayload,
  | "date"
  | "designPattern"
  | "daily"
  | "scheduleDays"
  | "ads"
  | "weather"
  | "classContext"
  | "presenceCount"
  | "visitors"
  | "callouts"
  | "trainStatus"
  | "blackout"
>;

/**
 * 基底スナップショット + 編集中の当日下書きから、ライブプレビュー用の {@link SignagePayload} を組み立てる。
 *
 * - `daily.schedules` / `daily.notices` / `daily.assignments` を編集中 items に差し替える（source は `class`＝
 *   クラス由来の編集として扱う。継承バッジを出さない）。`quietHours` は編集対象外なので基底のまま。
 * - `scheduleDays` は当日列（`date` 一致）だけ編集中 schedules に差し替え、他日付は基底のまま残す。
 *
 * 基底の他フィールド（広告・天気・クラス文脈・パターン2 専用ブロック・黒画面）は編集対象外なのでそのまま通す。
 */
export function buildEditorPreviewPayload(
  base: EditorBoardBase,
  draft: EditorBoardDraft,
): SignagePayload {
  const daily: EffectiveDailyData = {
    ...base.daily,
    // 編集中の当日セクションで上書き（クラス由来＝source: "class"。継承バッジは出さない）。
    schedules: { items: draft.schedules, source: "class" },
    notices: { items: draft.notices, source: "class" },
    assignments: { items: draft.assignments, source: "class" },
  };

  const scheduleDays: ScheduleDay[] = base.scheduleDays.map((day) =>
    day.date === base.date
      ? { date: day.date, schedule: { items: draft.schedules, source: "class" } }
      : day,
  );

  return {
    date: base.date,
    designPattern: base.designPattern,
    daily,
    scheduleDays,
    ads: base.ads,
    weather: base.weather,
    classContext: base.classContext,
    presenceCount: base.presenceCount,
    visitors: base.visitors,
    callouts: base.callouts,
    trainStatus: base.trainStatus,
    blackout: base.blackout,
  };
}
