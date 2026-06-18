/**
 * ADR-044: 環境省「熱中症予防情報サイト」alert CSV の **純粋なパース / 変換** ロジック。
 *
 * ネットワーク I/O は含まない（fixture でモックして単体検証できる、`jma.ts`（天気）/ `jma-warning.ts`（警報）と
 * 同じ方針）。取得・upsert・fail-soft の I/O 結線は `run.ts`（既存の天気 Job に相乗り）、Cloud Run Job エントリは
 * `weather-job.ts` が担う。
 *
 * ## 環境省 alert CSV の形（非公式・無保証, ADR-044 §残存リスク①）
 * `https://www.wbgt.env.go.jp/alert/dl/{YYYY}/alert_{YYYYMMDD}_{HH}.csv` は **全国 1 ファイル**（1 行 = 1 府県
 * 予報区）で、概ね次の構造（ASCII / LF 区切り、確認済 2026 シーズン）:
 *
 *   Title,熱中症特別警戒情報・熱中症警戒情報,...
 *   CreateDate,2026/03/30,...
 *   ReportDate,2026/03/30,...
 *   FlagExplanation,発表無し:0、熱中症警戒情報発表:1、熱中症特別警戒情報判定:2、熱中症特別警戒情報発表:3、発表時間外:9,...
 *   府県予報区,都府県・振興局表示番号,...サブ,府県予報区等コード,都道府県名,都道府県コード,TargetDate1フラグ,TargetDate2フラグ,日最高WBGT（10:00）,日最高WBGT（17:00）,日最高WBGT（5:00）
 *   岐阜県,52,0,210000,岐阜,21,0,0,河合:30/...（地点別の WBGT を / 区切り）,,
 *   東京都,44,0,130000,東京,13,1,0,小河内:31/...,,
 *
 * 列の意味（確認済）:
 *   - 「府県予報区等コード」（4 列目, 0-index 3）= JMA 府県予報区コードと同体系（例 岐阜県 = '210000'）。
 *     本サービスのキャッシュキー `area_code` に対応する（`resolveJmaAreaCode` で導出した値と一致する）。
 *   - TargetDate1 フラグ（7 列目, 0-index 6）= 当日のアラート段階フラグ。TargetDate2（8 列目）= 翌日。
 *     フラグ値: 0=発表無し / 1=熱中症警戒情報発表 / 2=特別警戒判定 / 3=特別警戒発表 / 9=発表時間外。
 *   - 日最高WBGT（9〜11 列目）= 地点別ピーク WBGT を `地点名:値/...` で連結。値の最大をその日のピークとする。
 *
 * フォーマットが予告なく変わりうるため、**全列を防御的に**読む（列数不足・非数値・空は null / none に倒し、throw
 * しない）。CSV 全文（原文）は呼び出し側が `raw` ではなく、本パーサが該当行を正規化して返した内容を保全する
 * （CSV 全文は他県も含むため、地域行のみ raw に残す）。
 */

import type { HeatAlertLevel, WbgtBand } from "@kimiterrace/db";

/** パース結果（1 地域・1 日ぶん）。取得 Job が `upsertHeatAlert` 入力にそのまま渡せる正規形。 */
export interface ParsedHeatAlert {
  areaCode: string;
  /** 府県予報区名（CSV の 1 列目）。無ければ null。 */
  areaName: string | null;
  /** 当日（TargetDate1）の熱中症アラート段階（none < warning < emergency）。 */
  alertLevel: HeatAlertLevel;
  /** その日のピーク WBGT（整数℃相当）。取得できない場合は null（fail-soft）。 */
  wbgtMax: number | null;
  /** ピーク WBGT の区分。WBGT が無ければ null。 */
  wbgtBand: WbgtBand | null;
  /** 原文保全用に正規化した CSV 該当行のフィールド（PII 非格納の公開値のみ）。 */
  raw: {
    areaCode: string;
    areaName: string | null;
    prefName: string | null;
    targetDate1Flag: string | null;
    targetDate2Flag: string | null;
    wbgtCells: string | null;
  };
}

/**
 * 環境省 alert CSV のアラートフラグ（TargetDate1/2 フラグ列の値）→ 段階の正規化。
 * 0=発表無し / 1=熱中症警戒 / 2=特別警戒判定(未発表) / 3=特別警戒発表 / 9=発表時間外。
 * 表示は「発表されたアラート」の 3 段階に正規化する。**2（判定のみ・未発表）と 9（時間外）と未知/欠落は none**
 * に倒す（fail-soft / 過剰警告を出さない）。
 */
export function heatFlagToLevel(flag: string | null): HeatAlertLevel {
  if (flag == null) return "none";
  switch (flag.trim()) {
    case "1":
      return "warning";
    case "3":
      return "emergency";
    default:
      // 0 / 2(判定のみ) / 9(時間外) / 未知 → none。
      return "none";
  }
}

/**
 * WBGT 値（整数℃相当）→ 区分。日本生気象学会 / 環境省「日常生活に関する指針」の 5 区分（℃）:
 *   < 21: ほぼ安全 / 21..<25: 注意 / 25..<28: 警戒 / 28..<31: 厳重警戒 / >=31: 危険。
 * null / 非有限は null（区分なし）に倒す（fail-soft）。
 */
export function wbgtToBand(wbgt: number | null): WbgtBand | null {
  if (wbgt == null || !Number.isFinite(wbgt)) return null;
  if (wbgt < 21) return "almost_safe";
  if (wbgt < 25) return "caution";
  if (wbgt < 28) return "warning";
  if (wbgt < 31) return "severe";
  return "danger";
}

/**
 * CSV 1 行を素朴にフィールド分割する（環境省 CSV はクオート無しの単純カンマ区切り、ASCII）。
 * 防御的: 改行（CR）を落とし、前後空白は呼び出し側で trim する。RFC 4180 のクオート/エスケープは
 * 本サービスの CSV では使われない前提（無保証なので、想定外でも分割だけは落とさない）。
 */
function splitCsvLine(line: string): string[] {
  return line.replace(/\r$/, "").split(",");
}

/**
 * 「地点名:値/地点名:値/...」形式の WBGT セルから最大値（整数）を取り出す。
 * 値が 1 つも取れなければ null（fail-soft）。値は整数℃相当（環境省 alert CSV は ℃ 整数で提供）。
 */
function parseWbgtPeak(cell: string | null): number | null {
  if (cell == null) return null;
  let max: number | null = null;
  for (const pair of cell.split("/")) {
    // 「地点名:値」。値側だけを数値化する（地点名にコロンが無い前提だが、末尾要素を採って防御）。
    const parts = pair.split(":");
    const valueRaw = parts.length >= 2 ? parts[parts.length - 1] : parts[0];
    const n = Number.parseInt((valueRaw ?? "").trim(), 10);
    if (Number.isFinite(n)) {
      max = max == null ? n : Math.max(max, n);
    }
  }
  return max;
}

/** 列インデックス（確認済 2026 シーズンの alert CSV）。フォーマット変化に備え定数で集約。 */
const COL = {
  areaName: 0,
  areaCode: 3,
  prefName: 4,
  targetDate1Flag: 6,
  targetDate2Flag: 7,
  wbgt1000: 8,
  wbgt1700: 9,
  wbgt0500: 10,
} as const;

/** 非空文字列を返す（空・undefined は null）。 */
function nonEmpty(v: string | undefined): string | null {
  if (v == null) return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/**
 * 環境省 alert CSV（全国 1 ファイルの全文テキスト）から、指定 `areaCode`（府県予報区等コード）の **当日
 * （TargetDate1）** アラートを取り出して正規化する。
 *
 * 防御的: CSV が壊れていても throw せず、該当行が無ければ `alertLevel='none' / wbgt=null` の安全な既定を返す
 * （last-known-good を壊さない）。WBGT は 10:00 列を主、無ければ 17:00 → 5:00 の順でフォールバックして最大を採る。
 *
 * @param areaCode 取得・突合に使う府県予報区コード（例 '210000'）。
 * @param csvText  `alert_{YYYYMMDD}_{HH}.csv` の生テキスト（全国分。非文字列は壊れ扱いで none に倒す）。
 */
export function parseEnvHeatAlert(areaCode: string, csvText: unknown): ParsedHeatAlert {
  const safe = (): ParsedHeatAlert => ({
    areaCode,
    areaName: null,
    alertLevel: "none",
    wbgtMax: null,
    wbgtBand: null,
    raw: {
      areaCode,
      areaName: null,
      prefName: null,
      targetDate1Flag: null,
      targetDate2Flag: null,
      wbgtCells: null,
    },
  });

  if (typeof csvText !== "string" || csvText.length === 0) {
    return safe();
  }

  for (const rawLine of csvText.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.length === 0) continue;
    const cols = splitCsvLine(line);
    // 該当地域行のみを処理（4 列目 = 府県予報区等コード）。メタ行・ヘッダ行はコードが一致しないので skip。
    if (nonEmpty(cols[COL.areaCode]) !== areaCode) continue;

    const areaName = nonEmpty(cols[COL.areaName]);
    const prefName = nonEmpty(cols[COL.prefName]);
    const targetDate1Flag = nonEmpty(cols[COL.targetDate1Flag]);
    const targetDate2Flag = nonEmpty(cols[COL.targetDate2Flag]);
    // WBGT は 10:00 列を主に、空なら 17:00 → 5:00 をフォールバック（朝晩のみ提供される時間帯対策）。
    const wbgtCells =
      nonEmpty(cols[COL.wbgt1000]) ?? nonEmpty(cols[COL.wbgt1700]) ?? nonEmpty(cols[COL.wbgt0500]);
    const wbgtMax = parseWbgtPeak(wbgtCells);

    return {
      areaCode,
      areaName,
      alertLevel: heatFlagToLevel(targetDate1Flag),
      wbgtMax,
      wbgtBand: wbgtToBand(wbgtMax),
      raw: {
        areaCode,
        areaName,
        prefName,
        targetDate1Flag,
        targetDate2Flag,
        wbgtCells,
      },
    };
  }

  // 該当地域行が無い（その県は当日対象外 / CSV 形式変化）→ 安全な既定（none / null）。
  return safe();
}
