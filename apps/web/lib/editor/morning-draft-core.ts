import type { SignageDesignPattern } from "../signage/design-pattern";
import { editableBlocksForPattern, scheduleInputVariant } from "../signage/pattern-blocks";
import { type EditorDayEvent, dayEventToNoticeItem, dayEventToScheduleItem } from "./day-events";
import {
  type AssignmentItem,
  type NoticeItem,
  validateNoticeItems,
} from "./notice-assignment-core";
import { type ScheduleItem, validateScheduleItems } from "./schedule-core";
import { type WeeklyTimetable, seedSchedulesForDate } from "./weekly-timetable-core";

/**
 * P0「朝ドラフト」の**合成コア**（editor-shipping-and-zero-input-2026-07.md §3.1・純関数）。
 *
 * 教員が毎朝ゼロから入力するコストを消すため、**既にバラバラに存在する 3 部品**
 * （週次基本時間割 seed / 年間行事 / 前日までの実データ）から「開いた瞬間に盤面の下書きが
 * できている」状態を組み上げる。**新しい変換ロジックは一切足さない** — 既存の純関数
 * （{@link seedSchedulesForDate} / {@link dayEventToScheduleItem} / {@link dayEventToNoticeItem}）を
 * 呼ぶだけの合成器である（day-events / weekly-timetable-core と同じ「DB 非依存・unit テスト可能」な純モジュール）。
 *
 * ## 設計決定（設計書 §3.1）
 * - **D1: 自動保存しない**。本コアは*表示合成*のみで DB に書かない。確定は Server Action
 *   （`confirmMorningDraftAction`・PR-Z2）が 1 クリックで行う（seed 方式・DB 未書込 draft と完全整合）。
 * - **D2: 来校者・呼び出しは合成対象外**（ADR-034 の PII 境界。前日から氏名を自動持ち越さない）。
 *   これらは合成源を持たないため出力にも現れない。
 * - **D3: 合成はパターン駆動**。{@link editableBlocksForPattern} が返す編集ブロックにだけ合成する。
 *   予定の時限入力形態が時刻型（{@link scheduleInputVariant} = `"time"` = pattern5）のパターンでは
 *   **時限ベースの基本時間割 seed を適用しない**（掲示板型に馴染まない）。行事由来の予定のみ載せる。
 * - **D4: 確定はサーバで再合成**。UI が組んだ items は信用しない。confirm action は date+classId+除外キー
 *   だけ受け取り、サーバで本関数を再実行して書く。そのため合成項目は**安定キー**（{@link MorningDraftItemKey}）を
 *   持ち、除外をキーで再現できる。
 *
 * ## 合成規則
 * **既に入力があるセクションには一切触れない**（空セクションのみ合成 = seed 方式と同じコピーオンライト）。
 * - `schedules`（パターンが `schedule` を出し、かつ現状が空のとき）: 基本時間割 seed の結果 ＋ 行事の予定写像。
 * - `notices`（パターンが `notice` を出し、かつ現状が空のとき）: 行事の連絡写像。
 * - `assignments`（提出物）: **決定論の合成源が無いため合成しない**（入力の `existing.assignments` は
 *   「その日の daily_data 全体」を渡す整合のために受け取るが、出力には現れない）。
 * - 固定・持ち越し連絡は既存の表示合成（page.tsx）に任せ、ここでは重複させない。
 */

/** 合成対象になりうるセクション（提出物は合成源が無いので含めない）。 */
export type MorningDraftSection = "schedules" | "notices";

/** 合成項目の出所。UI バッジと除外キーの安定 id の根拠にする（設計書 §3.1）。 */
export type MorningDraftProvenance = "基本時間割" | "年間行事";

/**
 * 合成項目 1 件の**安定キー**。教員が × で除外した項目を、確定時にサーバが再合成した結果の中から
 * 同定するために使う（D4）。決定論で再現できる素材のみをキー成分にする:
 * - `schedules:timetable:<index>` … 基本時間割 seed の index 番目（テンプレは決定的順序）
 * - `schedules:event:<eventId>` … 行事由来の予定（`school_calendar_events.id`）
 * - `notices:event:<eventId>` … 行事由来の連絡
 */
export type MorningDraftItemKey = string;

/** 合成された予定 1 件（キー・出所・{@link ScheduleItem} 本体）。 */
export type MorningDraftScheduleEntry = {
  key: MorningDraftItemKey;
  provenance: MorningDraftProvenance;
  item: ScheduleItem;
};

/** 合成された連絡 1 件（キー・出所・{@link NoticeItem} 本体）。 */
export type MorningDraftNoticeEntry = {
  key: MorningDraftItemKey;
  provenance: MorningDraftProvenance;
  item: NoticeItem;
};

/** 全項目の出所フラット一覧の 1 行（`sections` の射影・UI の除外リスト駆動用）。 */
export type MorningDraftProvenanceRow = {
  section: MorningDraftSection;
  key: MorningDraftItemKey;
  provenance: MorningDraftProvenance;
};

/** {@link buildMorningDraft} の結果。除外適用済みの合成内容と、その出所一覧。 */
export type MorningDraft = {
  /** 除外適用後の合成内容。空セクションはキーごと省略する（`schedules` が undefined = 予定は合成なし）。 */
  sections: {
    schedules?: MorningDraftScheduleEntry[];
    notices?: MorningDraftNoticeEntry[];
  };
  /** 全合成項目の出所（section+key+provenance）。`sections` の順序どおりのフラット射影。 */
  provenance: MorningDraftProvenanceRow[];
  /** 合成結果が空（＝カードを出す価値が無い）。UI の表示判定に使う。 */
  isEmpty: boolean;
};

/** {@link buildMorningDraft} の入力（その日の素材一式）。 */
export type MorningDraftInput = {
  /** 編集中の対象日（YYYY-MM-DD）。 */
  date: string;
  /** 対象端末/学校の実効サイネージパターン（合成対象セクションを駆動）。 */
  pattern: SignageDesignPattern;
  /**
   * 対象日の**現 daily_data**。空判定に使う（コピーオンライト = 空セクションのみ合成）。
   * `assignments` は合成源を持たないため読まないが、「その日の全体」を渡す整合のため受け取る。
   */
  existing: {
    schedules: ScheduleItem[];
    notices: NoticeItem[];
    assignments: AssignmentItem[];
  };
  /** 対象日の曜日に対応する基本時間割（未登録校は null）。 */
  weeklyTimetable: WeeklyTimetable | null;
  /** 対象日に該当する年間行事（{@link eventsForEditorDate} 済みの射影）。 */
  dayEvents: readonly EditorDayEvent[];
  /** 教員が × で除外した項目のキー（省略 = 除外なし）。 */
  excluded?: readonly MorningDraftItemKey[];
};

/**
 * 素材から今日の盤面下書きを**表示合成**する（DB には書かない・D1）。除外キーを適用した最終形を返す。
 * 純関数（unit テスト対象）。同じ入力で確定時にサーバが再実行しても同一結果になる（D4 の再現性の根拠）。
 */
export function buildMorningDraft(input: MorningDraftInput): MorningDraft {
  const { date, pattern, existing, weeklyTimetable, dayEvents } = input;
  const excluded = new Set(input.excluded ?? []);
  const editable = new Set(editableBlocksForPattern(pattern));

  const scheduleEntries: MorningDraftScheduleEntry[] = [];
  const noticeEntries: MorningDraftNoticeEntry[] = [];

  // 予定: パターンが schedule を出し、かつ現状が空のときだけ合成（コピーオンライト）。
  if (editable.has("schedule") && existing.schedules.length === 0) {
    // 基本時間割 seed。時刻型パターン（pattern5 = scheduleInputVariant "time"）は時限ベース seed を
    // 適用しない（D3）。seed 判定（平日か・その曜日のテンプレ登録有無）は既存純関数へ委譲する。
    if (weeklyTimetable && scheduleInputVariant(pattern) === "period") {
      const seeded = seedSchedulesForDate(date, existing.schedules, weeklyTimetable);
      if (seeded.seeded) {
        seeded.items.forEach((item, index) => {
          scheduleEntries.push({
            key: `schedules:timetable:${index}`,
            provenance: "基本時間割",
            item,
          });
        });
      }
    }
    // 行事由来の予定。
    for (const ev of dayEvents) {
      scheduleEntries.push({
        key: `schedules:event:${ev.id}`,
        provenance: "年間行事",
        item: dayEventToScheduleItem(ev),
      });
    }
  }

  // 連絡: パターンが notice を出し、かつ現状が空のときだけ合成（行事由来のみ）。
  if (editable.has("notice") && existing.notices.length === 0) {
    for (const ev of dayEvents) {
      noticeEntries.push({
        key: `notices:event:${ev.id}`,
        provenance: "年間行事",
        item: dayEventToNoticeItem(ev),
      });
    }
  }

  // 除外を適用（D4: 教員が × した項目をキーで落とす）。
  const keptSchedule = scheduleEntries.filter((entry) => !excluded.has(entry.key));
  const keptNotice = noticeEntries.filter((entry) => !excluded.has(entry.key));

  const sections: MorningDraft["sections"] = {};
  if (keptSchedule.length > 0) {
    sections.schedules = keptSchedule;
  }
  if (keptNotice.length > 0) {
    sections.notices = keptNotice;
  }

  const provenance: MorningDraftProvenanceRow[] = [
    ...keptSchedule.map(
      (entry): MorningDraftProvenanceRow => ({
        section: "schedules",
        key: entry.key,
        provenance: entry.provenance,
      }),
    ),
    ...keptNotice.map(
      (entry): MorningDraftProvenanceRow => ({
        section: "notices",
        key: entry.key,
        provenance: entry.provenance,
      }),
    ),
  ];

  return {
    sections,
    provenance,
    isEmpty: keptSchedule.length === 0 && keptNotice.length === 0,
  };
}

/**
 * 確定書込のための**検証済みプラン**（{@link planMorningDraftWrite} の結果）。書く予定 / 連絡の検証済み items
 * を持つ（空セクションはキーごと省略＝書かない）。
 */
export type MorningDraftWritePlan =
  | { ok: true; schedules?: ScheduleItem[]; notices?: NoticeItem[] }
  | { ok: false; message: string };

/**
 * 合成結果を保存前に**両セクションまとめて検証**する（確定 Server Action の fail-closed 防壁・純関数）。予定 /
 * 連絡それぞれ非空なら {@link validateScheduleItems} / {@link validateNoticeItems} を通す。1 つでも不正なら
 * `{ok:false}` を返し、**呼び出し側はどのセクションも書かない**（＝書込前に全検証＝部分適用を構造的に防ぐ。
 * 「予定を書いた後に連絡が検証失敗して部分コミット」を起こさない）。合成された items は既に妥当な純関数由来
 * だが、`upsertDailySectionForTarget` が無検証で書くため防御として必ず通す。
 */
export function planMorningDraftWrite(draft: MorningDraft): MorningDraftWritePlan {
  const plan: { schedules?: ScheduleItem[]; notices?: NoticeItem[] } = {};
  if (draft.sections.schedules) {
    const v = validateScheduleItems(draft.sections.schedules.map((entry) => entry.item));
    if (!v.ok) {
      return { ok: false, message: v.message };
    }
    plan.schedules = v.value;
  }
  if (draft.sections.notices) {
    const v = validateNoticeItems(draft.sections.notices.map((entry) => entry.item));
    if (!v.ok) {
      return { ok: false, message: v.message };
    }
    plan.notices = v.value;
  }
  return { ok: true, ...plan };
}
