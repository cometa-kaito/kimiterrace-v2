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
 * エラーメッセージから接続文字列 (DSN) を伏せる（ルール5: secret をログに出さない）。
 * postgres 接続エラーは host / 認証情報を message に含めうるため、URL を一律マスクする。
 */
function redactDsn(s: string): string {
  return s.replace(/postgres(?:ql)?:\/\/[^\s"]+/gi, "postgres://<redacted>");
}

async function main(): Promise<void> {
  const batchSizeRaw = env.EMBED_BATCH_SIZE;
  const config: RunEmbeddingBatchConfig = {
    databaseUrl: requireEnv("DATABASE_URL"),
    project: requireEnv("GCP_PROJECT"),
    location: env.VERTEX_LOCATION ?? "asia-northeast1",
    modelId: env.EMBEDDING_MODEL_ID,
    batchSize: batchSizeRaw ? Number.parseInt(batchSizeRaw, 10) : undefined,
  };

  const summary = await runEmbeddingBatch(config);
  // 件数サマリのみ info ログに（Cloud Logging の構造化ログ）。secret / PII は出さない。
  console.info(JSON.stringify({ event: "embedding.batch.done", summary }));
}

main().catch((err) => {
  const message = redactDsn(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  console.error(JSON.stringify({ event: "embedding.batch.error", message }));
  exit(1);
});
