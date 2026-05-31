/**
 * F09 (#45): 月次レポートの **対象月 (年・月) 計算ユーティリティ**。純粋関数のみ (DB 非依存)。
 *
 * 月次レポートは JST 暦月を単位にする。ここでは UI の月ナビ (前後月・現在月・`?ym=YYYY-MM` の
 * パース) に必要な月演算を、タイムゾーン取り違えなく行う小道具をまとめる。集計クエリ側
 * (packages/db `getMonthlySchoolSummary`) も JST 暦月で窓を切るため、表示と集計の月境界が揃う。
 */

/** 年 (西暦) と 月 (1-12) の対。 */
export type YearMonth = { year: number; month: number };

const MIN_MONTH = 1;
const MAX_MONTH = 12;
/** JST = UTC+9 (日本は夏時間なし)。 */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * 現在時刻の **JST 暦月**を返す。
 *
 * サーバのローカルタイムゾーンに依存しないよう、UTC エポックに +9h して UTC ゲッタで読む
 * (= JST の壁時計)。Cloud Run (UTC) でもローカル開発でも同じ JST 月になる。
 */
export function currentJstYearMonth(now: Date = new Date()): YearMonth {
  const jst = new Date(now.getTime() + JST_OFFSET_MS);
  return { year: jst.getUTCFullYear(), month: jst.getUTCMonth() + 1 };
}

/**
 * `?ym=YYYY-MM` 形式の文字列を `YearMonth` にパースする。形式不正・範囲外・未指定は `null`。
 *
 * UI からの入力なので厳格に検証する (集計クエリにそのまま渡す前のサニタイズ)。`YYYY` は 4 桁、
 * `MM` は 01-12 のみ受け付ける。
 */
export function parseYearMonth(raw: string | undefined | null): YearMonth | null {
  if (!raw) {
    return null;
  }
  const m = /^(\d{4})-(\d{2})$/.exec(raw);
  if (!m) {
    return null;
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < MIN_MONTH || month > MAX_MONTH) {
    return null;
  }
  return { year, month };
}

/** `YearMonth` を `?ym=` クエリ用の `YYYY-MM` 文字列にする (月はゼロ埋め)。 */
export function toYmParam(ym: YearMonth): string {
  return `${ym.year}-${String(ym.month).padStart(2, "0")}`;
}

/** 日本語表示用に `2026年6月` 形式へ整形する。 */
export function formatYearMonth(ym: YearMonth): string {
  return `${ym.year}年${ym.month}月`;
}

/** `delta` か月だけずらした `YearMonth` を返す (月の繰り上げ/繰り下げを年へ伝播)。 */
export function shiftMonth(ym: YearMonth, delta: number): YearMonth {
  // 0-index 月で加算してから 12 で正規化する (負の delta も Math.floor で正しく繰り下がる)。
  const zeroBased = ym.year * 12 + (ym.month - 1) + delta;
  return { year: Math.floor(zeroBased / 12), month: (((zeroBased % 12) + 12) % 12) + 1 };
}

/** a が b より後の月か (年→月の辞書順比較)。 */
export function isAfterMonth(a: YearMonth, b: YearMonth): boolean {
  return a.year > b.year || (a.year === b.year && a.month > b.month);
}

/** 同じ年月か。 */
export function isSameMonth(a: YearMonth, b: YearMonth): boolean {
  return a.year === b.year && a.month === b.month;
}
