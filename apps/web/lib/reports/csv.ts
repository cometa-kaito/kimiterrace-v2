import type { MonthlySchoolSummary } from "@kimiterrace/db";
import { formatYearMonth } from "./month";

/**
 * F09 (#45) 第2スライス: 月次 **学校別サマリーの CSV シリアライズ**。純粋関数のみ (DB / I/O 非依存)。
 *
 * 第1スライス (`/admin/reports`) が画面に出している `MonthlySchoolSummary` を、教員が表計算ソフトへ
 * 取り込める CSV テキストへ落とす。PDF 生成・`monthly_reports` 履歴・Cloud Storage 保存は後続スライス
 * とし、本スライスは「サーバ側集計をそのまま 1 ファイルで持ち帰れる」最小の配布手段を用意する。
 *
 * ## PII / 監査 (ルール4 / NFR04)
 * 入力 `MonthlySchoolSummary` は件数 (整数)・content タイトル・稼働日数のみで、`events.payload` の
 * 匿名 clientId 等を含まない (集計層 `getMonthlySchoolSummary` がそう作る)。CSV も同じ粒度しか出さず、
 * 個人を再識別しうる列は持たない。
 *
 * ## フォーマット (RFC 4180 + Excel/ja 互換)
 * - 区切りは `,`、改行は CRLF。`,` / `"` / 改行を含む値は二重引用符で囲み、内部の `"` は `""` に倍化。
 * - 先頭に UTF-8 BOM を付け、Excel が日本語 (UTF-8) を文字化けせず開けるようにする。
 * - 数値は桁区切りを入れない (表計算側で数値として扱えるよう生の整数で出す)。
 */

/** CSV 1 セルのエスケープ (RFC 4180)。`,` `"` CR LF のいずれかを含むと二重引用符で囲む。 */
export function escapeCsvField(value: string | number): string {
  const s = String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** 行 (セル配列) を CSV の 1 レコードへ (各セルをエスケープして `,` 連結)。 */
function toRow(cells: Array<string | number>): string {
  return cells.map(escapeCsvField).join(",");
}

/** Excel が UTF-8 を正しく判定するための BOM。 */
const BOM = "﻿";
/** RFC 4180 のレコード区切り。 */
const CRLF = "\r\n";

/**
 * `MonthlySchoolSummary` を月次レポート CSV 文字列へ変換する (BOM 付き、CRLF 区切り)。
 *
 * 構成は「ヘッダ → 指標サマリー (表示/タップ/Q&A/稼働日数) → コンテンツ反応ランキング」の 3 ブロックを
 * 空行で区切る。ランキングが空でもヘッダ行は出し、列構造を一定に保つ (取り込み側のパースを安定させる)。
 */
export function monthlySummaryToCsv(summary: MonthlySchoolSummary): string {
  const ym = formatYearMonth({ year: summary.year, month: summary.month });
  const rows: string[] = [
    toRow(["キミテラス 月次レポート", ym]),
    toRow(["集計基準", "日本時間(JST) 暦月"]),
    "",
    toRow(["指標", "件数"]),
    toRow(["表示 (view)", summary.totals.view]),
    toRow(["タップ (tap)", summary.totals.tap]),
    toRow(["Q&A (ask)", summary.totals.ask]),
    toRow(["稼働日数", summary.activeDays]),
    "",
    toRow(["順位", "コンテンツ", "表示", "タップ", "合計"]),
    ...summary.ranking.map((row, i) => toRow([i + 1, row.title, row.views, row.taps, row.total])),
  ];
  return BOM + rows.join(CRLF) + CRLF;
}

/** ダウンロード時のファイル名 (`monthly-report-YYYY-MM.csv`、ASCII 固定で Content-Disposition を簡潔に)。 */
export function monthlyCsvFilename(year: number, month: number): string {
  return `monthly-report-${year}-${String(month).padStart(2, "0")}.csv`;
}
