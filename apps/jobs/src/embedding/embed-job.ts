import { env, exit } from "node:process";
import { type RunEmbeddingBatchConfig, runEmbeddingBatch } from "./run.js";

/**
 * F06 (#398, #365): 公開コンテンツ embedding 生成バッチの Cloud Run Job エントリ。
 *
 * 使い方: `node src/embedding/embed-job.ts`（Cloud Run Job のコンテナ起動コマンド）。
 * ロジックは `run.ts`（`runEmbeddingBatch` / `embedAllSchools`、フェイクで単体検証可能）に置き、
 * 本ファイルは env 読取・構造化ログ・終了コードの I/O 結線のみに徹する（`migration/firestore-to-pg.ts`
 * と同じ分離）。
 *
 * 必須 env:
 * - `DATABASE_URL`: **kimiterrace_app ロール**（非 BYPASSRLS）。Secret Manager 経由で注入し、
 *   コード/コミットされる env にハードコードしない（ルール2・5）。
 * - `GCP_PROJECT`: Vertex AI の GCP プロジェクト ID。
 * 任意 env:
 * - `VERTEX_LOCATION`（既定 asia-northeast1、NFR07 データ越境ゼロ）
 * - `EMBEDDING_MODEL_ID`（既定は @kimiterrace/ai のピン。ADR-007 で gemini-embedding-001@768 に確定）
 * - `EMBED_BATCH_SIZE`（1 回の embed 呼び出し件数、既定 32）
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
 * 任意の正整数 env を取得する（未設定 / 非数値 / 0 以下なら undefined → 呼び出し側の既定にフォールバック）。
 * `Number.parseInt("abc")` 等は `NaN` を返すため、`raw ? Number.parseInt(...) : undefined` だと NaN が
 * そのまま `batchSize` に流れ、`Math.max(1, Math.trunc(NaN)) = NaN` で分割ループが 1 周も回らず **embedding を
 * 1 件も生成しない無言失敗**になる。`Number.isFinite` で弾いて既定（32）に倒す（tv-liveness-job と同方針）。
 */
function optionalIntEnv(name: string): number | undefined {
  const raw = env[name];
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * エラーメッセージから接続文字列 (DSN) を伏せる（ルール5: secret をログに出さない）。
 * postgres 接続エラーは host / 認証情報を message に含めうるため、URL を一律マスクする。
 */
function redactDsn(s: string): string {
  return s.replace(/postgres(?:ql)?:\/\/[^\s"]+/gi, "postgres://<redacted>");
}

async function main(): Promise<void> {
  const config: RunEmbeddingBatchConfig = {
    databaseUrl: requireEnv("DATABASE_URL"),
    project: requireEnv("GCP_PROJECT"),
    location: env.VERTEX_LOCATION ?? "asia-northeast1",
    modelId: env.EMBEDDING_MODEL_ID,
    // 非数値（NaN）を渡さない。未設定 / 不正なら undefined で既定（32）に倒す（無言で 0 件生成を防ぐ）。
    batchSize: optionalIntEnv("EMBED_BATCH_SIZE"),
  };

  const summary = await runEmbeddingBatch(config);
  // AI kill-switch（AI_ENABLED）が無効で Vertex を一切呼ばず skip した場合は、その旨を明示ログして正常終了
  // する（#593、ルール4 / ADR-030）。Job が（Scheduler 等で）起動されても AI 無効中は no-op で抜ける。
  // バッチは冪等なので、AI 有効化後の次回起動で未処理分を回収できる。
  if (summary.aiDisabled) {
    console.warn(JSON.stringify({ event: "embedding.batch.ai_disabled" }));
    return;
  }
  // 件数サマリのみ info ログに（Cloud Logging の構造化ログ）。secret / PII は出さない。
  console.info(JSON.stringify({ event: "embedding.batch.done", summary }));
  // fail-closed ゲートが PII 残存で version を skip した場合は WARN を立て、Cloud Logging の
  // severity ベースのアラート対象にする（ルール4 / docs/compliance/embedding-pii-masking.md の runbook）。
  // 件数のみ（生 PII は出さない）。skip された version は次回バッチで再処理される（冪等）。
  if (summary.blockedUnmaskedPii > 0) {
    console.warn(
      JSON.stringify({
        event: "embedding.batch.pii_blocked",
        blockedUnmaskedPii: summary.blockedUnmaskedPii,
        schools: summary.schools,
      }),
    );
  }
}

main().catch((err) => {
  const message = redactDsn(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  console.error(JSON.stringify({ event: "embedding.batch.error", message }));
  exit(1);
});
