import { type TenantTx, dailyData } from "@kimiterrace/db";
import { and, eq, gte, lte } from "drizzle-orm";

/**
 * クラスエディタ最下部のカレンダー用クエリ（内容ドット）。
 *
 * `getClassContentDates`: 指定クラスの期間 [start, end]（YYYY-MM-DD・両端含む）で「内容のある日」
 * （daily_data に予定 / 連絡 / 提出物のいずれかが入っている日）の一覧を返す。カレンダーはこの集合の日に
 * 点を打ち、「どの日に内容を入れたか」を俯瞰できるようにする。
 *
 * **RLS（ルール2）**: `withSession` の自校 tx 内で呼ぶ。daily_data の SELECT は `app.current_school_id` で
 * 自校に限定される（別テナントのクラスは不可視）。空配列のみの日は内容なし扱いで返さない。
 * ※ 来校者 / 呼び出し（class_visitors / student_callouts）は対象外（pattern2/3 の付随要素・"ある程度" の俯瞰）。
 */
export async function getClassContentDates(
  tx: TenantTx,
  classId: string,
  start: string,
  end: string,
): Promise<string[]> {
  const rows = await tx
    .select({
      date: dailyData.date,
      schedules: dailyData.schedules,
      notices: dailyData.notices,
      assignments: dailyData.assignments,
    })
    .from(dailyData)
    .where(
      and(
        eq(dailyData.scope, "class"),
        eq(dailyData.classId, classId),
        gte(dailyData.date, start),
        lte(dailyData.date, end),
      ),
    );

  const dates: string[] = [];
  for (const row of rows) {
    const hasContent =
      (Array.isArray(row.schedules) && row.schedules.length > 0) ||
      (Array.isArray(row.notices) && row.notices.length > 0) ||
      (Array.isArray(row.assignments) && row.assignments.length > 0);
    if (hasContent) {
      dates.push(row.date);
    }
  }
  return dates;
}

/** `YYYY-MM-DD`（UTC・ゼロ詰め）を組む。期間境界は日付のみなので UTC で扱い TZ ズレを避ける。 */
function ymdUtc(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/**
 * 選択日（YYYY-MM-DD）の月とその前後 1 か月を覆う期間 [start, end]（両端含む・YYYY-MM-DD）。
 * カレンダーの月送り（±1 か月）はクライアント側だが、よく見る前後 1 か月ぶんの内容ドットを先に
 * 取得しておくための窓（API を増やさず "ある程度" の俯瞰を満たす）。`Date.UTC` の月オーバーフロー正規化で
 * 年跨ぎも扱える。
 */
export function monthWindow(date: string): { start: string; end: string } {
  const [y, m] = date.split("-").map(Number);
  const year = y ?? 2026;
  const month0 = (m ?? 1) - 1;
  const start = new Date(Date.UTC(year, month0 - 1, 1)); // 前月 1 日
  const end = new Date(Date.UTC(year, month0 + 2, 0)); // 翌月末日（翌々月の 0 日）
  return { start: ymdUtc(start), end: ymdUtc(end) };
}
