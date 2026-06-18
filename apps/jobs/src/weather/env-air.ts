/**
 * ADR-046: 環境省「そらまめくん」大気汚染データ（PM2.5 等）の **純粋なパース / 変換** ロジック。
 *
 * ネットワーク I/O は含まない（fixture でモックして単体検証できる、`env-heat.ts`（熱中症）/ `jma.ts`（天気）と
 * 同じ方針）。取得・upsert・fail-soft の I/O 結線は `run.ts`（既存の天気 Job に相乗り）、Cloud Run Job エントリは
 * `weather-job.ts` が担う。
 *
 * ## ★ そらまめくんは「最も脆いソース」（ADR-046 §残存リスク①）
 * 環境省「そらまめくん」(https://soramame.env.go.jp) は keyless・公開だが、**正規の公開 JSON/CSV API 契約が
 * 確認できない JS SPA**（測定局コードベースの内部 API を叩く実質スクレイプ相当・非公式無保証）。JMA bosai JSON や
 * 環境省 熱中症 alert CSV のように URL/形式を確認できないため、本パーサは **JMA / 熱中症 CSV 以上に完全防御的**に
 * 作る:
 *   - 入力 `raw` は形が不確実な `unknown`（run.ts の取得層が「該当地域の代表測定値らしきオブジェクト」を渡す）。
 *   - フィールド名・型・存在は一切前提にせず、複数の候補キーを順に当て、数値化できなければ null に倒す。
 *   - throw しない（壊れていても安全な既定 = 全 null を返し last-known-good を壊さない）。
 *   - 取得できた生値は `raw` にそのまま保全し、後追い解析・障害調査に回す。
 *
 * UV（気象庁 紫外線情報）は現状 GRIB2 バイナリ配信で keyless-JSON/CSV の府県単位取得が確立していないため、
 * **本 PR では取得しない**（`uvIndex` / `uvBand` は常に null。schema は列を用意済み・follow-up、ADR-046 §UV）。
 *
 * ## PM2.5 区分（pm25Band）
 * 環境省「注意喚起のための暫定的な指針（日平均 70µg/m³）」を踏まえ、サイネージ表示用の段階区分に正規化する:
 *   good(良)        … PM2.5 < 12   （µg/m³, 環境基準の日平均 35 を十分下回る良好域の目安）
 *   moderate(やや)  … 12 <= PM2.5 < 35
 *   unhealthy(注意) … 35 <= PM2.5 < 70 （環境基準超過域）
 *   hazardous(警戒) … PM2.5 >= 70   （暫定指針値超過 = 注意喚起レベル）
 * 区分体系はソースの脆さ・指針の流動性を踏まえ schema 上は varchar（enum 化しない）。値が取れなければ null。
 */

/** パース結果（1 地域・1 日ぶん）。取得 Job が `upsertAirQuality` 入力にそのまま渡せる正規形。 */
export interface ParsedAirQuality {
  areaCode: string;
  /** 地域名（府県名等）。無ければ null。 */
  areaName: string | null;
  /** PM2.5 濃度（µg/m³ 相当の整数）。取得できない場合は null（fail-soft）。 */
  pm25: number | null;
  /** PM2.5 の段階区分。PM2.5 が無ければ null。 */
  pm25Band: string | null;
  /** 光化学オキシダント（任意指標, ppb 相当の整数）。取得できない場合は null（本 PR は通常 null）。 */
  oxidant: number | null;
  /** UV インデックス（本 PR は取得経路が無いため常に null・列予約）。 */
  uvIndex: number | null;
  /** UV 区分（本 PR は常に null）。 */
  uvBand: string | null;
  /** 原文保全用に正規化したフィールド（PII 非格納の公開値のみ）。 */
  raw: {
    areaCode: string;
    areaName: string | null;
    pm25: number | null;
    oxidant: number | null;
    /** 取得層が渡した生オブジェクトのうち、解析に用いた候補値（後追い解析用、PII 非格納）。 */
    source: unknown;
  };
}

/**
 * PM2.5 値（µg/m³ 相当）→ 段階区分。null / 非有限 / 負値は null（区分なし）に倒す（fail-soft）。
 * 区分境界は schema コメント / ADR-046 と一致させる（単一ソース）。
 */
export function pm25ToBand(pm25: number | null): string | null {
  if (pm25 == null || !Number.isFinite(pm25) || pm25 < 0) return null;
  if (pm25 < 12) return "good";
  if (pm25 < 35) return "moderate";
  if (pm25 < 70) return "unhealthy";
  return "hazardous";
}

/**
 * `unknown` から最初に数値化できる候補キーの値を整数で取り出す（防御的）。
 * - 文字列・数値どちらも受ける（"33", 33, "33.4" → 33）。
 * - 候補キーは順に試し、有限数になる最初の値を採る。どれも数値化できなければ null。
 * - 負値・NaN・Infinity は null（fail-soft）。欠測コード（"-", "***", "" 等）も数値化に失敗するので自然に null。
 */
function pickInt(obj: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const v = obj[key];
    if (v == null) continue;
    const n = typeof v === "number" ? v : Number.parseFloat(String(v).trim());
    if (Number.isFinite(n)) {
      const i = Math.trunc(n);
      if (i >= 0) return i;
    }
  }
  return null;
}

/** `unknown` から最初に非空文字列になる候補キーの値を取り出す（防御的）。無ければ null。 */
function pickStr(obj: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "string") {
      const t = v.trim();
      if (t.length > 0) return t;
    }
  }
  return null;
}

/**
 * そらまめくんの「該当地域の代表測定値らしきオブジェクト」（取得層が渡す `unknown`）から大気質を正規化する。
 *
 * ★ 完全防御的: 入力が壊れていても throw せず、何も取れなければ全 null の安全な既定を返す（last-known-good を
 * 壊さない）。フィールド名はソース不確実（JS SPA・非公式）のため、想定されうる複数の候補キー（PM2.5 の英字/和字、
 * 大文字小文字違い、API レスポンスの別名）を順に当てる。取れた生値は `raw.source` に保全する。
 *
 * UV はここでは扱わない（本 PR 未取得・常に null。run.ts も UV を渡さない）。
 *
 * @param areaCode 突合・キャッシュキーに使う府県予報区コード（例 '210000'）。
 * @param raw      取得層が渡す代表測定値（非オブジェクト・null は壊れ扱いで全 null に倒す）。
 */
export function parseSoramameAir(areaCode: string, raw: unknown): ParsedAirQuality {
  const safe = (source: unknown): ParsedAirQuality => ({
    areaCode,
    areaName: null,
    pm25: null,
    pm25Band: null,
    oxidant: null,
    uvIndex: null,
    uvBand: null,
    raw: { areaCode, areaName: null, pm25: null, oxidant: null, source },
  });

  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return safe(raw);
  }

  const obj = raw as Record<string, unknown>;

  // PM2.5: ソース不確実のため複数候補キーを順に当てる（環境省 / 一般的な大気 API の別名を網羅）。
  const pm25 = pickInt(obj, ["pm25", "PM25", "pm2_5", "PM2_5", "pm2.5", "PM2.5", "pmTwoFive"]);
  // 光化学オキシダント（任意指標。Ox / OX。本 PR は通常取れない想定 = null）。
  const oxidant = pickInt(obj, ["ox", "OX", "oxidant", "Ox", "photochemicalOxidant"]);
  const areaName = pickStr(obj, [
    "areaName",
    "area_name",
    "prefName",
    "prefecture",
    "name",
    "stationName",
  ]);

  return {
    areaCode,
    areaName,
    pm25,
    pm25Band: pm25ToBand(pm25),
    oxidant,
    // UV は本 PR では取得しない（GRIB2 のみ・follow-up）。常に null（schema は列予約済み）。
    uvIndex: null,
    uvBand: null,
    raw: { areaCode, areaName, pm25, oxidant, source: raw },
  };
}
