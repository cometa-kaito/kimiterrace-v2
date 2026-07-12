/**
 * 年間行事予定表の**表示用**純ロジック（教員 FB「月順で線で区切って分かり易く」対応）。
 * 登録済み行事一覧（server・page.tsx）と AI 読み取りプレビュー（client・CalendarImportClient）の
 * **両方**が同じ月グループ化を使う単一ソース。DB / React 非依存で全て単体テスト可能
 * （calendar-import-core と同方針）。client からも import されるため **@kimiterrace/db を import
 * しない**（"use client" から db 値 import に到達すると next build が落ちる・#1269）。
 */

const DATE_SHAPE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 曜日ラベル（index 0=日..6=土）。 */
const WEEKDAY_JP = ["日", "月", "火", "水", "木", "金", "土"] as const;

/** 月グループ 1 件（items は startDate 昇順・グループ自体も月昇順）。 */
export interface CalendarMonthGroup<T> {
  /** ソート・React key 用（"2026-04"。日付不正グループは "invalid"）。 */
  monthKey: string;
  /** 月見出し（「2026年4月」。日付不正グループは「日付未設定」）。 */
  label: string;
  items: T[];
}

/** 日付形が不正（編集途中の空欄等）な行を寄せるグループの key。 */
export const INVALID_MONTH_KEY = "invalid";

/**
 * 行事を startDate（YYYY-MM-DD）昇順に並べ、月（YYYY-MM）ごとにグループ化する。
 * - グループは月昇順。年度窓（4月〜翌3月）は暦の年月順のままで自然に年度順になる。
 * - startDate が YYYY-MM-DD の形でない行（プレビュー編集中の空欄など）は落とさず、
 *   末尾の「日付未設定」グループに寄せる（沈黙で消さない）。
 * - 同日内の相対順は入力順を保つ（安定ソート）。
 */
export function groupEventsByMonth<T>(
  events: readonly T[],
  getStartDate: (ev: T) => string,
): CalendarMonthGroup<T>[] {
  const valid: { date: string; ev: T }[] = [];
  const invalid: T[] = [];
  for (const ev of events) {
    const date = getStartDate(ev);
    if (DATE_SHAPE_RE.test(date)) {
      valid.push({ date, ev });
    } else {
      invalid.push(ev);
    }
  }
  // YYYY-MM-DD はゼロ埋め固定長ゆえ文字列比較 = 日付順序（calendar-import-core と同作法）。
  // Array.prototype.sort は安定なので同日内は入力順が保たれる。
  valid.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const groups: CalendarMonthGroup<T>[] = [];
  for (const { date, ev } of valid) {
    const monthKey = date.slice(0, 7);
    const last = groups[groups.length - 1];
    if (last !== undefined && last.monthKey === monthKey) {
      last.items.push(ev);
    } else {
      groups.push({ monthKey, label: monthLabel(monthKey), items: [ev] });
    }
  }
  if (invalid.length > 0) {
    groups.push({ monthKey: INVALID_MONTH_KEY, label: "日付未設定", items: invalid });
  }
  return groups;
}

/** "2026-04" → 「2026年4月」（ゼロ埋めを外す）。 */
function monthLabel(monthKey: string): string {
  const [y, m] = monthKey.split("-");
  return `${y}年${Number(m)}月`;
}

/**
 * 行事 1 件の日付ラベル。単日 = 「4/8(水)」・複数日 = 「4/8(水)〜4/10(金)」。
 * YYYY-MM-DD は JST の暦日として扱う（曜日は UTC 構築で暦日どおり・TZ 非依存）。
 * 形が不正な場合はそのまま返す（表示で落とさない）。endDate が startDate と同じ・または
 * 不正な場合は単日表示にする。
 */
export function eventDateRangeLabel(startDate: string, endDate?: string | null): string {
  const start = singleDateLabel(startDate);
  if (endDate == null || endDate === "" || endDate === startDate) {
    return start;
  }
  const end = singleDateLabel(endDate);
  return `${start}〜${end}`;
}

/**
 * "2026-04-01" → 「2026年4月1日」（ゼロ埋めを外した和文表記）。年度窓（4/1〜翌3/31）の見出しに使う。
 * eventDateRangeLabel の M/D(曜) 短縮形と違い、年を含む正式表記（ISO 生値を教員に見せないため）。
 * 形が不正な場合はそのまま返す（表示で落とさない）。
 */
export function jpDateLabel(date: string): string {
  const m = DATE_SHAPE_RE.exec(date);
  if (m === null) {
    return date;
  }
  const [, y, mo, d] = m;
  return `${Number(y)}年${Number(mo)}月${Number(d)}日`;
}

/** "2026-04-08" → 「4/8(水)」。形が不正なら入力をそのまま返す。 */
function singleDateLabel(date: string): string {
  const m = DATE_SHAPE_RE.exec(date);
  if (m === null) {
    return date;
  }
  const [, y, mo, d] = m;
  const weekday = WEEKDAY_JP[new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d))).getUTCDay()];
  return `${Number(mo)}/${Number(d)}(${weekday})`;
}
