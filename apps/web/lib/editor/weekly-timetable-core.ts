import type { ScheduleItem, Validated } from "./schedule-core";
import { validateScheduleItems } from "./schedule-core";

/**
 * 週次ベース時間割（F5・editor-input-tiers-and-signage-paging.md §3 F5 / §6.5 / §7）の純粋ロジック・型・定数。
 * 基本時間割は **曜日（1=月..5=金）別の {@link ScheduleItem} 配列**を `{"1":[...], … "5":[...]}` の JSONB
 * （`class_weekly_schedules.schedule_by_weekday`）で持つ。各曜日の検証は日次予定と同じ
 * {@link validateScheduleItems} を流用する（時限重複不可・科目 1..32・特殊スロット可）。空の曜日はキーごと省略。
 *
 * `"use server"` を持たない純モジュール（node 環境で決定的に unit テストできる）。DB / 検証・保存は
 * `weekly-timetable-actions.ts` / `weekly-timetable-queries.ts` が担う。
 */

/** 平日（月〜金）の曜日番号。1=月 .. 5=金。土日は基本時間割の対象外。 */
export const WEEKDAY_NUMBERS = [1, 2, 3, 4, 5] as const;
export type WeekdayNumber = (typeof WEEKDAY_NUMBERS)[number];

/** 曜日番号の表示ラベル（エディタの列見出し）。 */
export const WEEKDAY_LABEL: Record<WeekdayNumber, string> = {
  1: "月",
  2: "火",
  3: "水",
  4: "木",
  5: "金",
};

/** 曜日（1..5）→ その曜日の基本時間割。キーは文字列（JSONB のキーは文字列）。 */
export type WeeklyTimetable = Partial<Record<`${WeekdayNumber}`, ScheduleItem[]>>;

function isWeekdayKey(key: string): key is `${WeekdayNumber}` {
  return key === "1" || key === "2" || key === "3" || key === "4" || key === "5";
}

/**
 * `YYYY-MM-DD` の曜日キー（"1"=月..."5"=金）。土日・不正日は `null`（基本時間割の対象外＝seed しない）。UTC 暦日で
 * 判定し端末 TZ に依存しない（`isValidDate` 等の他の日付ヘルパーと同作法）。
 */
export function weekdayKeyOfDate(date: string): `${WeekdayNumber}` | null {
  const parts = date.split("-");
  if (parts.length !== 3) {
    return null;
  }
  const [y, m, d] = parts.map(Number);
  const dt = new Date(Date.UTC(y as number, (m as number) - 1, d as number));
  if (Number.isNaN(dt.getTime())) {
    return null;
  }
  const dow = dt.getUTCDay(); // 0=日..6=土
  if (dow < 1 || dow > 5) {
    return null; // 土日
  }
  return String(dow) as `${WeekdayNumber}`;
}

/** テンプレートから指定曜日の基本時間割を取り出す（無ければ空配列）。 */
export function timetableForWeekday(
  timetable: WeeklyTimetable,
  weekdayKey: `${WeekdayNumber}`,
): ScheduleItem[] {
  return timetable[weekdayKey] ?? [];
}

/**
 * コピーオンライト seed の判定（F5・設計書 §6.5）。対象日の既存予定が**空 かつ 平日**で、その曜日の基本時間割が
 * 登録されているときだけ、テンプレをエディタの初期値として返す（`seeded: true`）。それ以外（既入力日・土日・
 * テンプレ未登録曜日）は既存 items をそのまま返す（`seeded: false`）。
 *
 * **daily_data には書かない**（教員が確認・保存して初めて materialize）。呼び出し側（page.tsx）は `seeded` で
 * 「基本時間割から反映（保存すると確定）」の注記を出し分ける。純関数（unit テスト対象）。
 */
export function seedSchedulesForDate(
  date: string,
  existing: ScheduleItem[],
  timetable: WeeklyTimetable,
): { items: ScheduleItem[]; seeded: boolean } {
  if (existing.length > 0) {
    return { items: existing, seeded: false }; // 既入力日は上書きしない（コピーオンライト）
  }
  const weekdayKey = weekdayKeyOfDate(date);
  if (!weekdayKey) {
    return { items: existing, seeded: false }; // 土日・不正日は対象外
  }
  const seeded = timetableForWeekday(timetable, weekdayKey);
  if (seeded.length === 0) {
    return { items: existing, seeded: false }; // その曜日のテンプレ未登録
  }
  return { items: seeded, seeded: true };
}

/**
 * 基本時間割 JSONB（`schedule_by_weekday`）を検証・正規化する。オブジェクトで、キーは "1".."5" のみ、各値は
 * `validateScheduleItems` を通す（1 曜日でも不正なら全体を拒否）。空配列の曜日はキーごと落とす（JSONB 最小化）。
 * 保存済みの壊れたデータにも防御的（呼び出し側は `ok:false` を空扱いに倒せる）。
 */
export function validateWeeklyTimetable(raw: unknown): Validated<WeeklyTimetable> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, message: "基本時間割の形式が不正です。" };
  }
  const out: WeeklyTimetable = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isWeekdayKey(key)) {
      return { ok: false, message: `曜日キー「${key}」が不正です（1〜5 のみ）。` };
    }
    const v = validateScheduleItems(value);
    if (!v.ok) {
      return {
        ok: false,
        message: `${WEEKDAY_LABEL[Number(key) as WeekdayNumber]}曜: ${v.message}`,
      };
    }
    if (v.value.length > 0) {
      out[key] = v.value;
    }
  }
  return { ok: true, value: out };
}
