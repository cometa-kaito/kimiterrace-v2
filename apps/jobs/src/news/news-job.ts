import { env, exit } from "node:process";
import { type RunNewsFetchConfig, parseFeedsEnv, runNewsFetchBatch } from "./run.js";

/**
 * pattern2/4 サイネージ「時事ニュース」取得 Cloud Run Job エントリ（ADR-043）。CC BY ソース（経産省 METI）は
 * 公式要約付き、要許諾ソース（JST 等）は見出しのみ（要約 gate は run.ts の `isSummaryAllowedSource`）。
 *
 * 使い方: `node dist/news/news-job.js`（Cloud Run Job のコンテナ起動コマンド）。Cloud Scheduler から
 * 30 分間隔で起動する想定（各機関フィードへの礼儀・低頻度取得、ADR-043 §決定）。ロジックは `run.ts`
 * （`runNewsFetchBatch` / `runNewsFetch`、フェイクで単体検証可能）に置き、本ファイルは env 読取・
 * 構造化ログ・終了コードの I/O 結線のみに徹する（weather-job.ts / railway-status-job.ts と同じ分離）。
 *
 * 必須 env:
 * - `DATABASE_URL`: **kimiterrace_app ロール**（非 BYPASSRLS）。Secret Manager 経由で注入し、コード/
 *   コミットされる env にハードコードしない（ルール5）。news_items 書込みは run.ts が system_admin context。
 * 任意 env:
 * - `NEWS_FETCH_USER_AGENT`: 各機関への明示 User-Agent（連絡先含む、ADR-043 §礼儀）。既定は連絡先付き UA。
 * - `NEWS_FETCH_TIMEOUT_MS`: HTTP タイムアウト（既定 10000）。
 * - `NEWS_FEEDS_JSON`: フィード定義の上書き（JSON 配列 [{source,sourceLabel,url}]）。未設定 / 不正なら
 *   DEFAULT_NEWS_FEEDS（meti / jst / mext）にフォールバック。
 *
 * ## fail-soft
 * 1 フィードの取得 / パース失敗は last-known-good を維持（既存キャッシュを消さない）。**部分失敗は終了
 * コード 0**（盤面は前回値で壊れない、次サイクルで回収）。全フィード失敗（設定不備 / 全断）のみ非ゼロ終了。
 *
 * ## 非スコープ（follow-up）
 * - Sentry への失敗送信（ADR-013）。現状は failed > 0 を WARN ログで表現する。
 * - audit_log への取得記録。news_items は非 PII の公開キャッシュで fetched_at が「いつ取得したか」の台帳に
 *   なるため、weather / railway と同方針で audit_log への二重記録は別 follow-up とする。
 */

/** 必須 env を取得する（未設定は throw）。 */
function requireEnv(name: string): string {
  const v = env[name];
  if (!v) {
    throw new Error(
      `${name} が未設定です。Secret Manager / Cloud Run Job env で注入してください。`,
    );
  }
  return v;
}

/**
 * 任意の正整数 env を取得する（未設定 / 非数値 / 0 以下なら undefined → 既定にフォールバック）。
 * `raw ? Number.parseInt(...) : undefined` だと非数値で `NaN` が `timeoutMs` に流れ、`config.timeoutMs ?? 10_000`
 * は `NaN`（nullish でない）を素通しして `setTimeout(abort, NaN)` ≒ `setTimeout(abort, 0)` となり **全 fetch を
 * 即 abort** する。`Number.isFinite` で弾いて既定（10s）に倒す（weather / railway / tv-liveness-job と同方針）。
 */
function optionalIntEnv(name: string): number | undefined {
  const raw = env[name];
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * エラーメッセージから接続文字列（DSN）を伏せる（ルール5: secret をログに出さない）。
 * postgres 接続エラーは host / 認証情報を message に含めうるため、URL を一律マスクする。
 */
function redactDsn(s: string): string {
  return s.replace(/postgres(?:ql)?:\/\/[^\s"]+/gi, "postgres://<redacted>");
}

async function main(): Promise<void> {
  const feeds = parseFeedsEnv(env.NEWS_FEEDS_JSON);
  const config: RunNewsFetchConfig = {
    databaseUrl: requireEnv("DATABASE_URL"),
    userAgent:
      env.NEWS_FETCH_USER_AGENT ??
      "kimiterrace-news-fetch/1.0 (+https://rebounder.jp; contact: ops@rebounder.jp)",
    // 非数値（NaN）を渡さない。未設定 / 不正なら undefined で既定（10s）に倒す（即 abort を防ぐ）。
    timeoutMs: optionalIntEnv("NEWS_FETCH_TIMEOUT_MS"),
    // NEWS_FEEDS_JSON 由来のフィード上書き。null（未設定 / 不正）なら run.ts が DEFAULT_NEWS_FEEDS に倒す。
    ...(feeds ? { feeds } : {}),
  };

  const summary = await runNewsFetchBatch(config);
  // 件数サマリのみ info ログに（Cloud Logging の構造化ログ）。secret / PII / 見出し本文は出さない。
  console.info(JSON.stringify({ event: "news.fetch.done", summary }));

  // 一部フィードの取得失敗（last-known-good は維持済）は WARN を立て severity ベースのアラート対象にする。
  // failedFeeds は公開の source ラベルのみ（PII でない）。
  if (summary.failed > 0) {
    console.warn(
      JSON.stringify({
        event: "news.fetch.partial_failure",
        failed: summary.failed,
        feeds: summary.feeds,
        failedFeeds: summary.failedFeeds,
      }),
    );
    // 全フィード失敗（全断 / 設定不備）のみ非ゼロ終了で fail させる。部分失敗は last-known-good で
    // サイネージが壊れないため成功扱い（次サイクルで回収、冪等な upsert）。
    if (summary.fetchedFeeds === 0 && summary.feeds > 0) {
      exit(1);
    }
  }
}

main().catch((err) => {
  const message = redactDsn(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  console.error(JSON.stringify({ event: "news.fetch.error", message }));
  exit(1);
});
