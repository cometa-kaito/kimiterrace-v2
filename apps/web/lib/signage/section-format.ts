/**
 * サイネージ盤面の日次セクション要素 → 表示用テキストへの整形 (#48-E1 / #48-E2 共有単一ソース)。
 *
 * **背景**: daily_data の各セクション JSONB は #48-A では opaque 保持され、要素スキーマは後続スライスで
 * 確定した:
 *  - schedules:   {@link ScheduleItem}   `{ period, subject, note?, location?, targetAudience? }` (#48-H)
 *  - notices:     {@link NoticeItem}     `{ text, isHighlight? }`        (#48-I)
 *  - assignments: {@link AssignmentItem} `{ deadline, subject, task }`   (#48-I)
 *  - quietHours:  {@link QuietRange}     `{ start, end }` ("HH:MM")       (#48-J-2)
 *
 * スキーマ確定前は 2 レンダラ (admin プレビュー `SignageBoard` #48-E1 / 公開 `SignageClient` #48-E2) が
 * **同一の lossy な `itemLabel`** を各々重複実装しており、`["title","label","text","subject",...]` の
 * 先頭ヒットだけを拾っていた。その結果:
 *  - 予定は `subject` のみ表示し**時限 (period) を捨てる**、
 *  - 提出物は `subject` のみ表示し**期限 (deadline)・内容 (task) を捨てる**、
 *  - 連絡は `text` を表示するが**重要マーク (isHighlight) を反映しない**、
 *  - 静粛時間は一致するキーが無いため `JSON.stringify` され `{"start":"12:30",...}` と**生 JSON が露出**
 *    していた (公開サイネージ = 生徒が見る画面の表示バグ)。
 *
 * 本モジュールはその整形を **kind ごとに確定スキーマで rich 化**して一本化する。型は
 * `@/lib/editor/*` / `quiet-hours-core` / `effective-daily-data` を単一ソースとし、整形ロジックは
 * {@link field} 経由でフィールド名を **`keyof CoreType` にコンパイル時結合**する。core 側がフィールドを
 * 改名すると本モジュールがコンパイルエラーになり、静かな lossy 化を機械的に検知する (CLAUDE.md ルール3:
 * 型の単一ソースを人力レビューに依存せず機械強制。#247 / PR #238 Reviewer M-1)。`import type` のみで
 * ランタイム値は持ち込まず、`"use client"` な `SignageClient` のバンドルを汚さない (#148/#48-J の教訓)。
 *
 * **fail-soft**: items は依然 opaque JSONB (旧データ / 将来差分 / エディタ未経由の投入がありうる) なので、
 * kind 別に**防御的に narrow** し、想定形でなければ従来同等の汎用ラベル抽出にフォールバックする
 * (表示は壊さない)。整形は副作用なしの純関数 — node 環境で網羅 unit テスト可能。
 */

import type { AssignmentItem, NoticeItem } from "@/lib/editor/notice-assignment-core";
import type { ScheduleItem, SchedulePeriod } from "@/lib/editor/schedule-core";
import { isCustomPeriod, isSpecialSlot, scheduleSlotLabel } from "@/lib/editor/schedule-core";
import type { QuietRange } from "@/lib/school-admin/quiet-hours-core";
import type { EffectiveDailyData } from "@/lib/signage/effective-daily-data";

/**
 * 日次セクションの種別。`EffectiveDailyData` のセクションフィールド名から派生し、手書き union の
 * 二重管理を排す (ルール3)。`EffectiveDailyData` 側のフィールド改名はこの `Pick` がコンパイル時に弾く。
 */
export type SignageSectionKind = keyof Pick<
  EffectiveDailyData,
  "schedules" | "notices" | "assignments" | "quietHours"
>;

/** 表示用の 1 行。`emphasis` は重要マーク (notice の isHighlight) のときのみ true。 */
export type SignageLine = { text: string; emphasis?: boolean };

/**
 * opaque JSONB から **core 型 `T` のフィールド名に機械結合**して生値 (unknown) を読む。
 * `key` は `keyof T & string` に制約されるため、core 側 ({@link ScheduleItem} 等) がフィールドを
 * 改名すると呼び出し側がコンパイルエラーになる (ルール3 の機械強制)。ランタイムは型を信用せず、
 * 戻り値を呼び出し側で {@link str} / `typeof` により defensive に narrow する (fail-soft)。
 */
function field<T>(rec: Record<string, unknown>, key: keyof T & string): unknown {
  return rec[key];
}

/** trim 済みの非空文字列を返す。非文字列・空は null。 */
function str(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** "YYYY-MM-DD" → "M/D" (前ゼロ無しの短縮表記)。形式不正はそのまま返す。 */
function shortDate(deadline: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(deadline);
  if (!m) {
    return deadline;
  }
  return `${Number(m[2])}/${Number(m[3])}`;
}

/**
 * opaque JSONB の `period` を表示用 `SchedulePeriod` に防御的に narrow する（fail-soft）。
 * 正の整数（数値時限）/ 特殊スロット文字列（朝 / 昼休み / 放課後）/ 中身のある自由入力（その他 `{ custom }`）
 * のみ採用し、それ以外は null（時限ラベルを出さない）。
 */
function slotOf(rec: Record<string, unknown>): SchedulePeriod | null {
  const period = field<ScheduleItem>(rec, "period");
  if (typeof period === "number" && Number.isInteger(period) && period > 0) {
    return period;
  }
  if (isSpecialSlot(period)) {
    return period;
  }
  if (isCustomPeriod(period) && period.custom.trim().length > 0) {
    return period;
  }
  return null;
}

/** 予定: "N限 科目（補足）" / "朝 科目"。`period` ラベルを冠して時限・時間帯を明示する。 */
function formatSchedule(rec: Record<string, unknown>): SignageLine | null {
  const subject = str(field<ScheduleItem>(rec, "subject"));
  if (!subject) {
    return null;
  }
  const slot = slotOf(rec);
  const head = slot !== null ? `${scheduleSlotLabel(slot)} ${subject}` : subject;
  const note = str(field<ScheduleItem>(rec, "note"));
  return { text: note ? `${head}（${note}）` : head };
}

/** 連絡: 本文 + 重要マーク (isHighlight=true のみ emphasis)。 */
function formatNotice(rec: Record<string, unknown>): SignageLine | null {
  const text = str(field<NoticeItem>(rec, "text"));
  if (!text) {
    return null;
  }
  return field<NoticeItem>(rec, "isHighlight") === true ? { text, emphasis: true } : { text };
}

/** 提出物: "科目：内容（〆 M/D）"。期限と内容を捨てずに表示する。 */
function formatAssignment(rec: Record<string, unknown>): SignageLine | null {
  const subject = str(field<AssignmentItem>(rec, "subject"));
  const task = str(field<AssignmentItem>(rec, "task"));
  if (!subject || !task) {
    return null;
  }
  const deadline = str(field<AssignmentItem>(rec, "deadline"));
  const body = `${subject}：${task}`;
  return { text: deadline ? `${body}（〆${shortDate(deadline)}）` : body };
}

/** 静粛時間: "開始–終了" (例: "12:30–13:00")。生 JSON を露出させない。 */
function formatQuietHours(rec: Record<string, unknown>): SignageLine | null {
  const start = str(field<QuietRange>(rec, "start"));
  const end = str(field<QuietRange>(rec, "end"));
  if (!start || !end) {
    return null;
  }
  return { text: `${start}–${end}` };
}

const FORMATTERS: Record<SignageSectionKind, (rec: Record<string, unknown>) => SignageLine | null> =
  {
    schedules: formatSchedule,
    notices: formatNotice,
    assignments: formatAssignment,
    quietHours: formatQuietHours,
  };

/**
 * 想定スキーマに合致しない opaque 要素の最終フォールバック (旧 `itemLabel` 互換)。
 * 文字列はそのまま、オブジェクトは代表キーの先頭ヒット、いずれも無ければ JSON 文字列。
 */
function genericLabel(item: unknown): string {
  if (typeof item === "string") {
    return item;
  }
  if (item && typeof item === "object") {
    const rec = item as Record<string, unknown>;
    for (const key of ["title", "label", "text", "subject", "name", "content"]) {
      const v = rec[key];
      if (typeof v === "string" && v.length > 0) {
        return v;
      }
    }
  }
  return JSON.stringify(item);
}

/**
 * 日次セクション要素 1 件を表示用テキストに整形する。`kind` で確定スキーマに沿って rich 化し、
 * 形が合わなければ汎用ラベルにフォールバックする (fail-soft、表示を壊さない)。
 */
export function formatSignageItem(kind: SignageSectionKind, item: unknown): SignageLine {
  if (item && typeof item === "object" && !Array.isArray(item)) {
    const line = FORMATTERS[kind](item as Record<string, unknown>);
    if (line) {
      return line;
    }
  }
  return { text: genericLabel(item) };
}

// =====================================================================================
// v1 レイアウト用の **構造化** パーサ (#48 サイネージ v1 デザイン移植)。
// 予定グリッドは「時限 (太字) + 内容」の 2 分割、提出物テーブルは「期限/科目/提出物」の 3 列に
// 分けて描くため、`formatSignageItem` の 1 行テキストとは別に各フィールドを返す。型は editor core を
// 単一ソースにし (ルール3)、想定外要素は null/フォールバックで fail-soft。
// =====================================================================================

/**
 * 予定 1 行: 時限ラベル (例「3限」、無ければ空) と内容 (科目 + 補足)。`location`（場所）/
 * `targetAudience`（対象者）はパターン2 盤面用の任意フィールド（未設定は null）。パターン1 は使わない。
 */
export type SignageScheduleRow = {
  periodLabel: string;
  content: string;
  location: string | null;
  targetAudience: string | null;
};

/** 予定要素を「時限 + 内容 (+ 場所 / 対象者)」に分ける。確定スキーマ外は時限空 + 汎用ラベルにフォールバック。 */
export function parseScheduleRow(item: unknown): SignageScheduleRow {
  if (item && typeof item === "object" && !Array.isArray(item)) {
    const rec = item as Record<string, unknown>;
    const subject = str(field<ScheduleItem>(rec, "subject"));
    if (subject) {
      const slot = slotOf(rec);
      const note = str(field<ScheduleItem>(rec, "note"));
      return {
        periodLabel: slot !== null ? scheduleSlotLabel(slot) : "",
        content: note ? `${subject}（${note}）` : subject,
        location: str(field<ScheduleItem>(rec, "location")),
        targetAudience: str(field<ScheduleItem>(rec, "targetAudience")),
      };
    }
  }
  return { periodLabel: "", content: genericLabel(item), location: null, targetAudience: null };
}

/** 提出物 1 行: 科目・提出物・期限 (短縮日付) + 締切までの残日数ラベルと緊急度。 */
export type SignageAssignmentRow = {
  subject: string;
  task: string;
  deadlineShort: string;
  daysLeft: string;
  isOverdue: boolean;
  isUrgent: boolean;
};

/**
 * 提出物要素を表の各列へ分ける。`today` (YYYY-MM-DD, JST) との差で残日数を出す。subject/task が
 * 揃わない要素は null (表に出さない)。期限が不正/欠損なら残日数は空・非緊急 (表示は壊さない)。
 */
export function parseAssignmentRow(item: unknown, today: string): SignageAssignmentRow | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return null;
  }
  const rec = item as Record<string, unknown>;
  const subject = str(field<AssignmentItem>(rec, "subject"));
  const task = str(field<AssignmentItem>(rec, "task"));
  if (!subject || !task) {
    return null;
  }
  const deadline = str(field<AssignmentItem>(rec, "deadline"));
  const days = deadline ? daysBetween(today, deadline) : null;
  return {
    subject,
    task,
    deadlineShort: deadline ? shortDate(deadline) : "",
    daysLeft: daysLeftLabel(days),
    isOverdue: days !== null && days < 0,
    // 締切まで3日以内 (当日含む) は緊急 (赤)。v1 calculateDaysLeft の days-urgent (diffDays<=3) に一致。
    isUrgent: days !== null && days >= 0 && days <= 3,
  };
}

/** `today`→`deadline` の暦日差 (日)。両方 `YYYY-MM-DD` のときのみ。UTC 組み立てで TZ ドリフト回避。 */
function daysBetween(today: string, deadline: string): number | null {
  const t = ymdToUtc(today);
  const d = ymdToUtc(deadline);
  if (t === null || d === null) {
    return null;
  }
  return Math.round((d - t) / 86_400_000);
}

/** `YYYY-MM-DD` を UTC ミリ秒へ (実在暦日のみ、桁溢れは null)。 */
function ymdToUtc(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) {
    return null;
  }
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    return null;
  }
  return dt.getTime();
}

/** 残日数 → 表示ラベル。超過/今日/明日/あとN日。null は空。 */
function daysLeftLabel(days: number | null): string {
  if (days === null) {
    return "";
  }
  if (days < 0) {
    return `${-days}日超過`;
  }
  if (days === 0) {
    return "今日";
  }
  if (days === 1) {
    return "明日";
  }
  return `あと${days}日`;
}
