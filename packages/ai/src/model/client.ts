/**
 * F03 モデル呼び出しの抽象境界（依存逆転）。
 *
 * オーケストレータ（`structureContent`）は具体的な LLM SDK を知らず、この `ModelClient` のみに
 * 依存する。これにより:
 * - 本番は Vertex AI Gemini アダプタ（`./vertex.ts`、ADR-005/006）を注入する。
 * - テストは決定的なフェイクを注入し、GCP 資格情報なしで JSON パース・Zod validate・リトライ・
 *   マスキング往復を完全に検証できる（ADR-012）。
 *
 * アダプタは JSON モードの**生テキスト**を返すだけにとどめ、パース・検証・リトライは
 * オーケストレータが一元的に持つ（ADR-017 決定2 の「Zod validate + 最大2回リトライ」）。
 */

export interface ModelUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ModelRequest {
  system: string;
  user: string;
}

export interface ModelResponse {
  /** JSON モードで生成された生テキスト（未パース）。 */
  text: string;
  usage: ModelUsage;
  /** 例: "gemini-1.5-pro-002"。監査の `model_version` 列に記録する。 */
  modelVersion: string;
}

export interface ModelClient {
  generate(req: ModelRequest): Promise<ModelResponse>;
}
