import type { AdReachByAd, MonthlySchoolSummary } from "@kimiterrace/db";
import { formatYearMonth } from "./month";

/**
 * F09 (#45) 第2スライス: 月次 **学校別サマリーの CSV シリアライズ**。純粋関数のみ (DB / I/O 非依存)。
 *
 * 第1スライス (`/app/reports`) が画面に出している `MonthlySchoolSummary` を、教員が表計算ソフトへ
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

/**
 * CSV formula injection (CWE-1236) の中和。`=` `+` `-` `@` や TAB/CR で始まるセルは、Excel 等が
 * 数式として評価しうるため先頭に `'` を前置して文字列扱いへ落とす。
 *
 * content タイトルは教員が自由入力する untrusted 値 (同一 school の信頼ドメイン内ではあるが、
 * 安全側に倒す。ルール: 便利さよりセキュリティ)。集計値 (件数・順位) は非負整数で先頭が危険文字に
 * ならないため対象外で、数値が文字列化される副作用も避ける。
 */
export function neutralizeCsvFormula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

/** 行 (セル配列) を CSV の 1 レコードへ (各セルをエスケープして `,` 連結)。 */
function toRow(cells: Array<string | number>): string {
  return cells.map(escapeCsvField).join(",");
}

/** Excel が UTF-8 を正しく判定するための BOM。 */
const BOM = "﻿";
/** RFC 4180 のレコード区切り。 */
const CRLF = "\r\n";

/** caption 未設定 / 削除済 広告の表示名 (画面の `/app/reports` と揃える)。 */
const UNTITLED_AD_LABEL = "（無題の広告）";

/**
 * `MonthlySchoolSummary` + `AdReachByAd[]` を月次レポート CSV 文字列へ変換する (BOM 付き、CRLF 区切り)。
 *
 * 構成は「ヘッダ → 指標サマリー (表示/タップ/Q&A/稼働日数) → コンテンツ反応ランキング → 広告別 到達数」の
 * 4 ブロックを空行で区切る。ランキング・到達数が空でもヘッダ行は出し、列構造を一定に保つ (取り込み側の
 * パースを安定させる)。
 *
 * 「延べ表示数 (engagement)」と「到達数 (reach)」は別指標 (ADR-025)。reach は `(client_id, ad_id, JST 分)`
 * で集計時 minute-dedup 済の値で、延べ件数を到達数として出さない。広告ラベル `caption` は untrusted 自由入力
 * のため formula injection を中和してから出す (件数のみで匿名 clientId は含まない / ルール4)。
 */
export function monthlySummaryToCsv(summary: MonthlySchoolSummary, adReach: AdReachByAd[]): string {
  const ym = formatYearMonth({ year: summary.year, month: summary.month });
  const rows: string[] = [
    toRow(["キミテラス 月次レポート", ym]),
    toRow(["集計基準", "日本時間(JST) 暦月"]),
    "",
    toRow(["指標", "件数"]),
    toRow(["延べ表示数 (engagement)", summary.totals.view]),
    toRow(["タップ (tap)", summary.totals.tap]),
    toRow(["Q&A (ask)", summary.totals.ask]),
    toRow(["稼働日数", summary.activeDays]),
    "",
    toRow(["順位", "コンテンツ", "表示", "タップ", "合計"]),
    ...summary.ranking.map((row, i) =>
      // title は untrusted 自由入力なので formula injection を中和してから出す。
      toRow([i + 1, neutralizeCsvFormula(row.title), row.views, row.taps, row.total]),
    ),
    "",
    toRow(["広告", "到達数 (reach)"]),
    ...adReach.map((a) =>
      // caption も untrusted 自由入力なので中和。未設定 / 削除済 (null) は無題ラベルへ。
      toRow([neutralizeCsvFormula(a.caption ?? UNTITLED_AD_LABEL), a.reach]),
    ),
  ];
  return BOM + rows.join(CRLF) + CRLF;
}

/** ダウンロード時のファイル名 (`monthly-report-YYYY-MM.csv`、ASCII 固定で Content-Disposition を簡潔に)。 */
export function monthlyCsvFilename(year: number, month: number): string {
  return `monthly-report-${year}-${String(month).padStart(2, "0")}.csv`;
}
