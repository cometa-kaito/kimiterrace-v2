import { addDays } from "@/lib/signage/effective-daily-data";
import { type TenantTx, getCalendarEvents } from "@kimiterrace/db";
import { DAY_EVENT_LOOKBACK_DAYS, type EditorDayEvent, eventsForEditorDate } from "./day-events";

/**
 * エディタ「この日の行事」（ADR-049 決定 7・PR-D）の**サーバ専用の読み取り**（schedule-queries /
 * notice-assignment-queries と同じ `*-queries` 分離規約）。
 *
 * ★ 純コア（day-events.ts）と分離する理由: day-events.ts は client component（DayEventsPanel）からも
 * import されるため、`@kimiterrace/db` の**値 import** をそこに置くとクライアントバンドルが barrel 経由で
 * `postgres`（`fs`/`net`/`tls`）へ到達して Next build が落ちる（#1269 CI 実証・vitest / tsc では検出不能）。
 * 本モジュールは server component / Server Action からのみ import すること（client からの import 禁止）。
 */

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
