import { addDays } from "@/lib/signage/effective-daily-data";
import { type SchoolCalendarEvent, type TenantTx, getCalendarEvents } from "@kimiterrace/db";
import { NOTICE_TEXT_MAX, type NoticeItem } from "./notice-assignment-core";
import { CUSTOM_PERIOD_MAX, LOCATION_MAX, SUBJECT_MAX, type ScheduleItem } from "./schedule-core";

/**
 * エディタ「この日の行事」（ADR-049 決定 7・PR-D）の純コア + 読み取り。
 *
 * `school_calendar_events`（iCal 取込 = ADR-045 / ファイル取込 = ADR-049 の両由来）から**編集中日付に
 * 該当する行事**を組み立て、教員がワンクリックで盤面の予定 / 連絡へ**確定挿入**できる形
 * （{@link ScheduleItem} / {@link NoticeItem}）へ写像する。保存経路は既存の per-section Server Action
 * （setScheduleAction / setNoticesAction）＝新しい書き込み経路は作らない（SeedConfirmButton と同型）。
 * 行事データを LLM / embedding に載せない方針（ADR-045 決定 4）はここでは何も変えない（表示と挿入のみ）。
 */

/**
 * 年間予定表ファイル取込ページ（PR-C 新設・ADR-049 決定 3/4）へのパス。**PR-C との導線契約**（このパスで
 * 確定済み）。パネルのフッタ「年間予定表を取り込む」が指す。
 */
export const CALENDAR_IMPORT_PAGE_PATH = "/app/editor/calendar-import";

/**
 * 複数日行事（startDate ≤ 対象日 ≤ endDate）を対象日に含めるための startDate 遡及窓（日数）。
 * {@link getCalendarEvents} は **startDate のレンジ**でしか絞れない（packages/db は不変・PR-D 制約）ため、
 * 対象日から 366 日前まで startDate を遡って読み、対象日を跨ぐ行事をアプリ側 {@link eventsForEditorDate}
 * で判定する。年間行事表 / iCal の行事は年度（≤366 日）を超えて跨がない想定（ADR-049 決定 3 の年度窓と同水準）。
 */
export const DAY_EVENT_LOOKBACK_DAYS = 366;

/**
 * エディタ「この日の行事」パネルの行事 1 件（client へ渡せる表示用射影）。DB 行（{@link SchoolCalendarEvent}）
 * から Date 等の非シリアライズ安全な形を落とし、時刻は JST の "HH:MM" 文字列へ確定させる。
 */
export type EditorDayEvent = {
  /** school_calendar_events.id（React key・操作対象の識別）。 */
  id: string;
  /** 行事名（空/NULL の行は {@link eventsForEditorDate} が除外するので常に非空）。 */
  summary: string;
  /** 場所（無ければ null）。 */
  location: string | null;
  /** 終日行事か。 */
  allDay: boolean;
  /** 時刻付き行事の開始時刻（JST "HH:MM"）。終日 / 時刻不明は null。 */
  timeLabel: string | null;
  /** 開始日（YYYY-MM-DD）。 */
  startDate: string;
  /** 終了日（複数日行事のみ・単日は null）。 */
  endDate: string | null;
};

/** JST の "HH:MM"（例 09:30）。en-GB + hour12:false でゼロ埋め 24h 固定（表示・custom 時限の両用）。 */
function jstTimeLabel(at: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(at);
}

/**
 * 取得済みの行事行から**対象日に該当する行事**だけを表示用射影へ写す。
 * - 該当 = `startDate ≤ 対象日 ≤ (endDate ?? startDate)`（複数日行事は期間中の毎日に出る・ADR-049 決定 7）。
 *   YYYY-MM-DD はゼロ埋め固定長ゆえ文字列比較 = 日付順序（calendar-import-core 等と同作法）。
 * - `summary` が NULL / 空白のみの行は除外する（挿入先の予定・連絡は本文必須＝ボタンを成立させられない）。
 * - 並びは入力順を保持（{@link getCalendarEvents} が startDate 昇順 → id 昇順で決定的）。
 */
export function eventsForEditorDate(
  rows: readonly SchoolCalendarEvent[],
  date: string,
): EditorDayEvent[] {
  const out: EditorDayEvent[] = [];
  for (const row of rows) {
    const summary = (row.summary ?? "").trim();
    if (summary.length === 0) {
      continue;
    }
    if (row.startDate > date || (row.endDate ?? row.startDate) < date) {
      continue;
    }
    out.push({
      id: row.id,
      summary,
      location: row.location,
      allDay: row.allDay,
      timeLabel: !row.allDay && row.startAt ? jstTimeLabel(row.startAt) : null,
      startDate: row.startDate,
      endDate: row.endDate,
    });
  }
  return out;
}

/**
 * 編集中日付の行事を RLS tx 内で読む（エディタ page.tsx から呼ぶ・ルール2 は呼び出し側の `withSession` が確立）。
 * {@link getCalendarEvents}（RLS 委譲・startDate レンジ）を対象日 − {@link DAY_EVENT_LOOKBACK_DAYS} 〜 対象日で
 * 呼び、複数日行事の当日包含を {@link eventsForEditorDate} で判定する。
 */
export async function getEditorDayEvents(
  tx: TenantTx,
  schoolId: string,
  date: string,
): Promise<EditorDayEvent[]> {
  const rows = await getCalendarEvents(tx, schoolId, addDays(date, -DAY_EVENT_LOOKBACK_DAYS), date);
  return eventsForEditorDate(rows, date);
}

/** "YYYY-MM-DD" → "M/D"（パネルの期間表示用・ゼロ埋めなし）。 */
function monthDayLabel(date: string): string {
  return `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
}

/**
 * パネルの行事メタ表示（色だけに頼らない補足）: 複数日は「7/10〜7/12」、時刻付きは "HH:MM"、それ以外は「終日」。
 */
export function dayEventMetaLabel(ev: EditorDayEvent): string {
  if (ev.endDate && ev.endDate !== ev.startDate) {
    return `${monthDayLabel(ev.startDate)}〜${monthDayLabel(ev.endDate)}`;
  }
  return ev.timeLabel ?? "終日";
}

/**
 * 「予定へ追加」の写像（ADR-049 決定 7）: 科目 = summary・場所 = location、時刻付き行事は時刻（JST "HH:MM"）を
 * 予定の時刻欄＝自由入力時限（`{ custom }`・掲示板型の時刻入力と同じ既存内部表現）へ入れる。終日行事は時限なし
 * （科目のみの予定）。各値はサーバ検証の上限（{@link SUBJECT_MAX} / {@link LOCATION_MAX} /
 * {@link CUSTOM_PERIOD_MAX}）へ丸め、行事名が長くても挿入自体は成立させる（教員が挿入後に編集できる）。
 */
export function dayEventToScheduleItem(ev: EditorDayEvent): ScheduleItem {
  const item: ScheduleItem = { subject: ev.summary.slice(0, SUBJECT_MAX) };
  if (ev.timeLabel) {
    item.period = { custom: ev.timeLabel.slice(0, CUSTOM_PERIOD_MAX) };
  }
  if (ev.location) {
    item.location = ev.location.slice(0, LOCATION_MAX);
  }
  return item;
}

/**
 * 「連絡へ追加」の写像（ADR-049 決定 7）: 本文 = summary（場所があれば「＠場所」を後置）。
 * サーバ検証の上限（{@link NOTICE_TEXT_MAX}）へ丸める。
 */
export function dayEventToNoticeItem(ev: EditorDayEvent): NoticeItem {
  const text = ev.location ? `${ev.summary}＠${ev.location}` : ev.summary;
  return { text: text.slice(0, NOTICE_TEXT_MAX) };
}
