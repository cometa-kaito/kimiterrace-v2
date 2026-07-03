/**
 * 前週コピー（C2・editor-input-tiers-and-signage-paging.md §7）の**純粋な週演算**。DB やブラウザ TZ に
 * 依存しない UTC 暦日演算で、週境界（月曜始まり）と月〜金の日割りを決定的に計算する（他の日付ヘルパー＝
 * `lib/signage/rotation.ts` と同作法・unit テスト可能）。月グリッド系の暦計算は `EditorDateCalendar` が
 * 既に担うのでここには置かない（週演算のみの最小モジュール）。
 */

/** `YYYY-MM-DD` に `n` 日足した日付（UTC 暦日演算・不正は空文字）。前週コピー等の週演算に使う。 */
export function addDaysUtc(date: string, n: number): string {
  const parts = date.split("-");
  if (parts.length !== 3) {
    return "";
  }
  const [y, m, d] = parts.map(Number);
  const base = new Date(Date.UTC(y as number, (m as number) - 1, d as number));
  if (Number.isNaN(base.getTime())) {
    return "";
  }
  const t = new Date(base.getTime() + n * 86_400_000);
  const mm = String(t.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(t.getUTCDate()).padStart(2, "0");
  return `${t.getUTCFullYear()}-${mm}-${dd}`;
}

/** `date` を含む週の**月曜日**（週は月曜始まり）。前週コピーの週境界に使う。不正は空文字。 */
export function mondayOfWeek(date: string): string {
  const parts = date.split("-");
  if (parts.length !== 3) {
    return "";
  }
  const [y, m, d] = parts.map(Number);
  const dow = new Date(Date.UTC(y as number, (m as number) - 1, d as number)).getUTCDay(); // 0=日..6=土
  const sinceMonday = (dow + 6) % 7; // 月曜からの経過日数（日曜=6）
  return addDaysUtc(date, -sinceMonday);
}

/** `monday`（週の月曜）から月〜金の 5 日（YYYY-MM-DD）を返す。前週コピーの日割りに使う。 */
export function businessWeek(monday: string): string[] {
  return Array.from({ length: 5 }, (_, i) => addDaysUtc(monday, i));
}
