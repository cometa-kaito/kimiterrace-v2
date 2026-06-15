import {
  type TenantTx,
  createDbClient,
  upsertRailwayStatus,
  withTenantContext,
} from "@kimiterrace/db";
import { type ParsedTrainStatus, parseMeitetsuStatus } from "./meitetsu.js";

/**
 * パターン2「鉄道」運行情報取得バッチの **オーケストレーション + I/O 結線**（ADR-035）。weather の run.ts と
 * 同方針で、純粋ロジック（パース = `meitetsu.ts`）と I/O（fetch / DB）を分け、依存注入でネットワーク・DB なしに
 * `runRailwayFetch` を単体検証できる。
 *
 * - **閉域 / PII 非送信（ADR-035）**: 外部 egress は本 Job だけ。端末（サイネージ）は DB キャッシュを読むだけ。
 *   名鉄へは何も個人情報を送らない（GET のみ）。
 * - **テナント分離（ルール2）**: upsert は system_admin context（`railway_status_write_system` policy）。
 *   BYPASSRLS は使わない。`railway_status` は school_id 非保持の公開キャッシュ。
 */

/** 当面の対象事業者（名鉄・笠松駅）。 */
export const MEITETSU_OPERATOR = "meitetsu";
export const MEITETSU_OPERATOR_NAME = "名鉄";
export const MEITETSU_STATUS_URL = "https://top.meitetsu.co.jp/em/";

/** `runRailwayFetch` の依存（fetch / DB を注入してネットワーク・DB なしで検証可能にする）。 */
export interface RailwayFetchDeps {
  /** 運行情報を取得・パースする（実体は HTTP fetch + `parseMeitetsuStatus`）。null = 認識できる文が無い。 */
  fetchStatus(): Promise<ParsedTrainStatus | null>;
  /** パース済みの現況を `railway_status` に upsert する（実体は system_admin context の upsert）。 */
  saveStatus(status: ParsedTrainStatus): Promise<void>;
}

/** バッチのサマリ（Cloud Logging に構造化ログ。secret / PII は含めない）。 */
export interface RailwayFetchSummary {
  /** upsert したか（false なら last-known-good 維持）。 */
  updated: boolean;
  /** 乱れ有無（updated 時のみ。未更新は null）。 */
  hasDisruption: boolean | null;
  /** 未更新の理由（'fetch_failed' / 'parse_failed'）。正常は null。 */
  skippedReason: "fetch_failed" | "parse_failed" | null;
}

/**
 * 運行情報取得バッチ本体（純粋オーケストレーション、fetch/DB は注入）。取得失敗・パース不能は **skip**
 * （既存キャッシュ = last-known-good を維持・盤面を壊さない、fail-soft）。例外は投げず summary を返す。
 */
export async function runRailwayFetch(deps: RailwayFetchDeps): Promise<RailwayFetchSummary> {
  let status: ParsedTrainStatus | null;
  try {
    status = await deps.fetchStatus();
  } catch {
    return { updated: false, hasDisruption: null, skippedReason: "fetch_failed" };
  }
  if (!status) {
    return { updated: false, hasDisruption: null, skippedReason: "parse_failed" };
  }
  await deps.saveStatus(status);
  return { updated: true, hasDisruption: status.hasDisruption, skippedReason: null };
}

/** HTTP 取得の設定（HTTP マナー: User-Agent / timeout）。 */
export interface HttpFetchConfig {
  /** 明示 User-Agent（連絡先を含めて名鉄に対し礼儀正しく。ADR-035 §礼儀）。 */
  userAgent: string;
  /** タイムアウト（ms）。既定 10s。 */
  timeoutMs?: number;
  /** 取得 URL（既定は名鉄運行情報ページ）。 */
  url?: string;
  /** テスト差し替え用の fetch 実装（既定は global fetch）。 */
  fetchImpl?: typeof fetch;
}

/**
 * 名鉄運行情報ページを HTTP 取得しパースする（実 I/O）。timeout / 明示 User-Agent を付ける。
 * 非 2xx・タイムアウトは throw（`runRailwayFetch` が捕捉して skip）。パース不能は null を返す。
 */
export async function fetchMeitetsuStatus(
  config: HttpFetchConfig,
): Promise<ParsedTrainStatus | null> {
  const fetchImpl = config.fetchImpl ?? fetch;
  // `?? 10_000` は nullish のみ。NaN（非数値 env 由来）は素通りし `setTimeout(abort, NaN)` ≒ 即 abort に
  // なるため、有限値でなければ既定 10s に倒す（多層防御）。
  const timeoutMs = Number.isFinite(config.timeoutMs) ? (config.timeoutMs as number) : 10_000;
  const url = config.url ?? MEITETSU_STATUS_URL;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { "User-Agent": config.userAgent, Accept: "text/html" },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`名鉄 運行情報 取得失敗: status=${res.status}`);
    }
    const html = await res.text();
    return parseMeitetsuStatus(html);
  } finally {
    clearTimeout(timer);
  }
}

/** 実行時の設定（DB 接続 / User-Agent。DATABASE_URL は Secret Manager 経由、ルール5）。 */
export interface RunRailwayFetchConfig {
  /** DB 接続文字列（kimiterrace_app ロール）。Secret Manager 経由で注入（ルール5）。 */
  databaseUrl: string;
  /** 名鉄への明示 User-Agent（連絡先を含める）。 */
  userAgent: string;
  /** HTTP タイムアウト（ms）。 */
  timeoutMs?: number;
  /** 取得 URL（既定は名鉄運行情報ページ）。 */
  url?: string;
  /** テスト用: BYPASSRLS 接続をアプリロールへ降格する SET LOCAL ROLE 先。本番は未指定。 */
  appRole?: string;
}

/**
 * 実 PG + 名鉄ページで運行情報取得バッチを実行する。接続は本関数が開き、終了時に必ず閉じる。
 * env 読取・プロセス終了コードは entrypoint（`railway-status-job.ts`）が担う（weather と同じ分離）。
 */
export async function runRailwayFetchBatch(
  config: RunRailwayFetchConfig,
): Promise<RailwayFetchSummary> {
  const { sql, db } = createDbClient(config.databaseUrl);
  const appRoleOptions = config.appRole !== undefined ? { appRole: config.appRole } : {};
  const httpConfig: HttpFetchConfig = {
    userAgent: config.userAgent,
    timeoutMs: config.timeoutMs,
    url: config.url,
  };
  try {
    return await runRailwayFetch({
      fetchStatus: () => fetchMeitetsuStatus(httpConfig),
      // upsert は system_admin context（railway_status_write_system policy が書込みを system に限定）。
      saveStatus: (status) =>
        withTenantContext(
          db,
          { role: "system_admin" },
          (tx: TenantTx) => saveStatus(tx, status),
          appRoleOptions,
        ),
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** パース済みの現況を railway_status に upsert する。 */
async function saveStatus(tx: TenantTx, status: ParsedTrainStatus): Promise<void> {
  await upsertRailwayStatus(tx, {
    operator: MEITETSU_OPERATOR,
    operatorName: MEITETSU_OPERATOR_NAME,
    hasDisruption: status.hasDisruption,
    statusText: status.statusText,
    sourceUrl: MEITETSU_STATUS_URL,
  });
}
