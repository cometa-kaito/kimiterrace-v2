/**
 * ADR-044: 気象庁（JMA）bosai 警報・注意報 JSON の **純粋なパース / 変換** ロジック。
 *
 * ネットワーク I/O は含まない（fixture でモックして単体検証できる、`jma.ts`（天気）と同じ方針）。
 * 取得・upsert・fail-soft の I/O 結線は `run.ts`（既存の天気 Job に相乗り）、Cloud Run Job エントリは
 * `weather-job.ts` が担う。
 *
 * ## JMA bosai warning の形（非公式・無保証, ADR-044 §残存リスク①）
 * `https://www.jma.go.jp/bosai/warning/data/warning/{areaCode}.json`（areaCode = 府県予報区）は概ね:
 *   {
 *     reportDatetime: "2026-06-18T10:39:00+09:00",
 *     headlineText: "...",
 *     areaTypes: [
 *       { areas: [ { code: "210010", warnings: [ { code: "03", status: "発表" }, ... ] }, ... ] },
 *       ...
 *     ]
 *   }
 * フォーマットが予告なく変わりうるため、**全フィールドを optional 扱いで防御的に**読む。読めない値は
 * null / 空に倒して落とさない（last-known-good を壊さない）。原文 JSON は呼び出し側が `raw` に保全する。
 *
 * status は「発表 / 継続 / 解除」等。**解除（"解除" もしくは数値 "0"）は出ていない扱い**にして maxLevel から
 * 除外する。それ以外（発表 / 継続 等）の最大段階を maxLevel に導出する（特別警報 > 警報 > 注意報 > none）。
 */

import type { WarningLevel } from "@kimiterrace/db";

/** 正規化済みの警報・注意報 1 件（DB の weather_warnings.warnings 配列要素に対応、PII 非格納）。 */
export interface ParsedWarning {
  /** JMA 警報コード（例 "03" = 大雨）。無ければ null。 */
  code: string | null;
  /** 警報名（コードから解決。未知コードは null）。 */
  name: string | null;
  /** 段階（注意報 / 警報 / 特別警報）。導出できない場合は null。 */
  level: WarningLevel | null;
  /** JMA status（"発表"/"継続"/"解除" 等。解除判定に使う）。 */
  status: string | null;
  /** 細分区域名（JMA areas[].name）。無ければ null。 */
  areaName: string | null;
}

/** パース結果（地域コード・最大段階・発表時刻・見出し + 正規化済み配列）。 */
export interface ParsedWarningSet {
  areaCode: string;
  /** その地域で出ている最大の警戒段階（解除は除外して導出）。 */
  maxLevel: WarningLevel;
  /** JMA reportDatetime（発表時刻、ISO 文字列）。無ければ null。 */
  reportDatetime: string | null;
  /** JMA headlineText（要約見出し）。無ければ null。 */
  headline: string | null;
  /** 正規化済みの警報・注意報（解除も含む。表示側で status を見て扱う）。 */
  warnings: ParsedWarning[];
}

/** unknown を配列として安全に取り出す（非配列は []）。`jma.ts` と同流儀。 */
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** unknown を record として安全に取り出す（非オブジェクトは {}）。`jma.ts` と同流儀。 */
function asRecord(v: unknown): Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/** unknown を非空文字列として安全に取り出す（それ以外は null）。 */
function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * JMA 警報コード → 段階 + 名称の静的マップ（単一ソース）。
 *
 * JMA bosai の warning コード体系（2 桁前後の数字）に基づく。コードの 30 番台は特別警報、それ以外の警報、
 * 注意報で段階が分かれる。網羅的ではない（未知コードは name=null / level=null に倒す）が、サイネージで
 * 強調が要る主要な警報・注意報を押さえる。コードは予告なく追加されうるため fail-soft（未知は無段階扱い）。
 *
 * 出典: 気象庁 bosai warning code（https://www.jma.go.jp/bosai/warning/）。
 */
const WARNING_CODE_MAP: Readonly<Record<string, { name: string; level: WarningLevel }>> = {
  // --- 特別警報（emergency） ---
  "32": { name: "暴風雪特別警報", level: "emergency" },
  "33": { name: "大雨特別警報", level: "emergency" },
  "35": { name: "暴風特別警報", level: "emergency" },
  "36": { name: "大雪特別警報", level: "emergency" },
  "37": { name: "波浪特別警報", level: "emergency" },
  "38": { name: "高潮特別警報", level: "emergency" },
  // --- 警報（warning） ---
  "02": { name: "暴風雪警報", level: "warning" },
  "03": { name: "大雨警報", level: "warning" },
  "04": { name: "洪水警報", level: "warning" },
  "05": { name: "暴風警報", level: "warning" },
  "06": { name: "大雪警報", level: "warning" },
  "07": { name: "波浪警報", level: "warning" },
  "08": { name: "高潮警報", level: "warning" },
  // --- 注意報（advisory） ---
  "10": { name: "大雨注意報", level: "advisory" },
  "12": { name: "大雪注意報", level: "advisory" },
  "13": { name: "風雪注意報", level: "advisory" },
  "14": { name: "雷注意報", level: "advisory" },
  "15": { name: "強風注意報", level: "advisory" },
  "16": { name: "波浪注意報", level: "advisory" },
  "17": { name: "融雪注意報", level: "advisory" },
  "18": { name: "洪水注意報", level: "advisory" },
  "19": { name: "高潮注意報", level: "advisory" },
  "20": { name: "濃霧注意報", level: "advisory" },
  "21": { name: "乾燥注意報", level: "advisory" },
  "22": { name: "なだれ注意報", level: "advisory" },
  "23": { name: "低温注意報", level: "advisory" },
  "24": { name: "霜注意報", level: "advisory" },
  "25": { name: "着氷注意報", level: "advisory" },
  "26": { name: "着雪注意報", level: "advisory" },
  "27": { name: "その他の注意報", level: "advisory" },
};

/** 段階の強さ（数値が大きいほど強い）。maxLevel 比較に使う。 */
const LEVEL_RANK: Readonly<Record<WarningLevel, number>> = {
  none: 0,
  advisory: 1,
  warning: 2,
  emergency: 3,
};

/** ランク → WarningLevel の逆引き（maxLevel 導出用）。 */
const RANK_TO_LEVEL: readonly WarningLevel[] = ["none", "advisory", "warning", "emergency"];

/**
 * JMA status が「解除（= 出ていない）」を表すか判定する。
 * bosai では解除を `"解除"` で表すほか、別系（warning/data の一部）では数値 `"0"` を解除に使う流儀がある。
 * 防御的に両方を解除扱いにする（解除は maxLevel 導出から除外する）。
 */
export function isClearedStatus(status: string | null): boolean {
  if (status == null) return false;
  const s = status.trim();
  return s === "解除" || s === "0";
}

/**
 * JMA warning JSON を地域コードごとの正規化警報集合に変換する。
 *
 * 防御的: 構造が欠けても throw せず、読めたぶんだけ `warnings` に詰める（空配列もありうる）。maxLevel は
 * **解除を除いた**警報のうち最大段階を採る（特別警報 > 警報 > 注意報 > none）。
 *
 * @param areaCode 取得に使った府県予報区コード（結果に保持。JSON 側の細分コードとは独立）。
 * @param json     `warning/{areaCode}.json` のパース済み JSON（オブジェクト想定）。
 */
export function parseJmaWarning(areaCode: string, json: unknown): ParsedWarningSet {
  const root = asRecord(json);
  const reportDatetime = asString(root.reportDatetime);
  const headline = asString(root.headlineText);

  const warnings: ParsedWarning[] = [];
  let maxRank = 0;

  for (const areaTypeRaw of asArray(root.areaTypes)) {
    const areaType = asRecord(areaTypeRaw);
    for (const areaRaw of asArray(areaType.areas)) {
      const area = asRecord(areaRaw);
      const subAreaName = asString(area.name);
      for (const wRaw of asArray(area.warnings)) {
        const w = asRecord(wRaw);
        const code = asString(w.code);
        const status = asString(w.status);
        const meta = code != null ? WARNING_CODE_MAP[code] : undefined;
        const level = meta?.level ?? null;
        warnings.push({
          code,
          name: meta?.name ?? null,
          level,
          status,
          areaName: subAreaName,
        });
        // 解除されていない（= 出ている）警報のみ maxLevel に反映する。
        if (level != null && !isClearedStatus(status)) {
          maxRank = Math.max(maxRank, LEVEL_RANK[level]);
        }
      }
    }
  }

  return {
    areaCode,
    maxLevel: RANK_TO_LEVEL[maxRank] ?? "none",
    reportDatetime,
    headline,
    warnings,
  };
}
