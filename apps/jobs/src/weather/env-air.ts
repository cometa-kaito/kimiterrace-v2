/**
 * ADR-046: 環境省「そらまめくん」大気汚染データ（PM2.5 等）の **純粋なパース / 変換** ロジック。
 *
 * ネットワーク I/O は含まない（fixture でモックして単体検証できる、`env-heat.ts`（熱中症）/ `jma.ts`（天気）と
 * 同じ方針）。取得・upsert・fail-soft の I/O 結線は `run.ts`（既存の天気 Job に相乗り）、Cloud Run Job エントリは
 * `weather-job.ts` が担う。
 *
 * ## ★ 実 keyless エンドポイントを確定（ADR-046 follow-up・本 fix の核）
 * 旧実装は「府県コード別 JSON」想定 URL（`/data/sokutei/code/{prefCode}.json`）を叩いていたが、これは **実在せず
 * そらまめくん SPA の index.html（HTTP 200 だが Content-Type: text/html）を返す**ため `res.json()` が throw し、
 * 本番 weather Job が `airFetched=0 / airFailed=1`（他指標は fail-soft で無事）に倒れていた。
 *
 * そこで SPA バンドル（`/js/app.*.js`）を解析し、SPA 自身が使う **実データ URL** を確認した（2026-06-19 実取得で
 * 確証）:
 *   - 鮮度メタ: `https://soramame.env.go.jp/data/sokutei/noudoAll/metadata.json`
 *     → `{"latest":"2026/06/19 09:00:00","oldest":"...","interval":"3600"}`（最新公開時刻）。
 *   - 全国 1 時間値 CSV（**全測定局を 1 ファイル**）: `…/noudoAll/{YYYY}/{MM}/{DD}/{HH}.csv`
 *     （SPA バンドルの `calDataOptions.rule = "{YYYY}/{MM}/{DD}/{HH}.csv"` と一致）。
 *     ヘッダ: `測定局コード,SO2,NO,NO2,NOX,CO,OX,NMHC,CH4,THC,SPM,PM2.5,SP,WD,WS,TEMP,HUM,測定局名称,住所,問い合わせ先,局種別,地域コード,都道府県コード,市区町村名`。
 *     1 行 = 1 測定局・当該 1 時間の実測値。**全 47 都道府県に PM2.5 値が存在**することを実取得で確認した。
 *
 * この CSV は **測定局単位**だが、本サービスのキャッシュキー `area_code` は JMA 府県予報区コード（府県単位、例
 * 岐阜 '210000'）。よって取得 Job は **府県コード（area_code の上 2 桁＝都道府県コード）でフィルタし、府県内の代表値
 * （PM2.5 の中央値）に畳む**（残存リスク②「測定局 ⇄ 府県」の決着）。中央値は外れ値（自排局の高め値・欠測局）に対し
 * 平均より頑健で、府県の代表的な大気状況を表す。
 *
 * ## 防御性（ADR-046 §残存リスク①「最も脆いソース」は維持）
 * 実 URL は確証したが、そらまめくんは依然 **非公式・無保証**（列順・公開時刻が予告なく変わりうる）。よって:
 *   - 列は **定数インデックスで集約**しつつ、ヘッダ行・メタ行・列数不足・非数値・欠測（空白セル）に対し防御的。
 *   - throw しない（壊れていても安全な既定 = 全 null を返し last-known-good を壊さない）。
 *   - 取得層が SPA の HTML fallback（非 CSV）を渡しても、該当府県行が見つからず自然に全 null に倒れる。
 *
 * UV（気象庁 紫外線情報）は現状 GRIB2 バイナリ配信で keyless-JSON/CSV の府県単位取得が確立していないため、
 * **本 PR では取得しない**（`uvIndex` / `uvBand` は常に null。schema は列を用意済み・follow-up、ADR-046 §UV）。
 * 光化学オキシダント（OX）は ppm 配信（ppb 換算・代表値選定が別途必要）で本 PR は取得しない（`oxidant` は常に null・列予約）。
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
  /** PM2.5 濃度（µg/m³ 相当の整数。府県内代表値 = 中央値）。取得できない場合は null（fail-soft）。 */
  pm25: number | null;
  /** PM2.5 の段階区分。PM2.5 が無ければ null。 */
  pm25Band: string | null;
  /** 光化学オキシダント（任意指標, ppb 相当の整数）。本 PR は取得しないため常に null（列予約）。 */
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
    /** 集計に用いた府県内 PM2.5 観測局数（後追い解析用、PII 非格納）。 */
    stationCount: number;
    /** 集計に用いた府県内 PM2.5 値（µg/m³、後追い解析用、PII 非格納）。 */
    pm25Samples: number[];
  };
}

/** そらまめくん全国 CSV の列インデックス（確認済 2026-06-19）。列順変化に備え定数で集約する。 */
const COL = {
  stationCode: 0,
  pm25: 11,
  stationName: 17,
  prefCode: 22,
} as const;

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
 * 単一セル（文字列）を非負整数化する（防御的）。
 * - "33" / "33.7"（少数）→ 33（切り捨て）。
 * - 欠測コード（"-" / "***" / "" / 空白のみ）は数値化に失敗するので null。
 * - 負値・NaN・Infinity は null（fail-soft）。
 */
function parseIntCell(raw: string | undefined): number | null {
  if (raw == null) return null;
  const n = Number.parseFloat(raw.trim());
  if (!Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  return i >= 0 ? i : null;
}

/**
 * 数値配列の中央値（整数）を返す。空配列は null。偶数個は下側中央（小さい方の中央値）を採り、外れ値に頑健に
 * 「実在する代表局の値」を返す（平均だと自排局の高め値・欠測の歪みを受けやすい）。
 */
function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  // 下側中央（length が奇数なら真ん中、偶数なら小さい方の中央）。`Math.trunc` で安全に整数 index に。
  const mid = Math.trunc((sorted.length - 1) / 2);
  return sorted[mid] ?? null;
}

/**
 * そらまめくん CSV 1 行をフィールド分割する（クオート無しの単純カンマ区切り、ASCII）。
 * 防御的: 改行（CR）を落とす。RFC 4180 のクオート/エスケープは本 CSV では使われない前提（無保証なので、想定外でも
 * 分割だけは落とさない）。
 */
function splitCsvLine(line: string): string[] {
  return line.replace(/\r$/, "").split(",");
}

/** 非空文字列を返す（空・undefined・空白のみは null）。 */
function nonEmpty(v: string | undefined): string | null {
  if (v == null) return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/**
 * 環境省「そらまめくん」全国 1 時間値 CSV（全測定局 1 ファイル）の全文から、指定 `areaCode`（JMA 府県予報区コード、
 * 上 2 桁 = 都道府県コード）に属する測定局の PM2.5 を集めて **府県代表値（中央値）** に畳んで正規化する。
 *
 * ★ 完全防御的（ADR-046 §残存リスク①）: 入力が壊れていても throw せず、該当府県の PM2.5 が 1 つも取れなければ
 * 全 null の安全な既定を返す（last-known-good を壊さない）。取得層が SPA の HTML fallback（非 CSV）を渡しても、
 * 都道府県コード列が一致する行が無いので自然に全 null に倒れる。
 *
 * UV / オキシダントはここでは扱わない（本 PR 未取得・常に null。run.ts も渡さない）。
 *
 * @param areaCode 突合・キャッシュキーに使う府県予報区コード（例 '210000'）。上 2 桁を都道府県コードとして使う。
 * @param csvText  全国 CSV の生テキスト（非文字列・空は壊れ扱いで全 null に倒す）。
 */
export function parseSoramameNoudoAllCsv(areaCode: string, csvText: unknown): ParsedAirQuality {
  const safe = (samples: number[] = []): ParsedAirQuality => {
    const pm25 = median(samples);
    return {
      areaCode,
      areaName: null,
      pm25,
      pm25Band: pm25ToBand(pm25),
      oxidant: null,
      uvIndex: null,
      uvBand: null,
      raw: {
        areaCode,
        areaName: null,
        pm25,
        oxidant: null,
        stationCount: samples.length,
        pm25Samples: samples,
      },
    };
  };

  if (typeof csvText !== "string" || csvText.length === 0) {
    return safe();
  }

  // 府県予報区コードの上 2 桁が都道府県コード（JIS 体系）に対応する（例 '210000' → 岐阜 '21'）。
  const prefCode = areaCode.slice(0, 2);
  if (prefCode.length !== 2) {
    // 想定外の areaCode（短すぎ等）は安全に全 null。
    return safe();
  }

  const samples: number[] = [];
  for (const rawLine of csvText.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.length === 0) continue;
    const cols = splitCsvLine(line);
    // 都道府県コード列が一致する測定局行のみ処理（ヘッダ行・他県行・メタ行は不一致で自然に skip）。
    // 全角空白等の混入に備え trim 済で比較する。
    if (nonEmpty(cols[COL.prefCode]) !== prefCode) continue;
    // 測定局コードの先頭 2 桁も都道府県コードと一致するはず（多層防御。不一致＝列ずれの兆候なら採らない）。
    const stationCode = nonEmpty(cols[COL.stationCode]);
    if (stationCode != null && !stationCode.startsWith(prefCode)) continue;
    const pm25 = parseIntCell(cols[COL.pm25]);
    if (pm25 != null) samples.push(pm25);
  }

  return safe(samples);
}
