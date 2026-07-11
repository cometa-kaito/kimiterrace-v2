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
  /**
   * 応答トークン上限（任意）。未指定は SDK 既定（上限を設けず必要分だけ生成 = ADR-017 の
   * truncation 回避方針。既存経路は挙動不変）。年間行事取込（ADR-049）のような長大な構造化出力で、
   * 想定件数が途切れない値を呼び出し側が明示しつつ暴走時のコスト CAP として使う。
   * Gemini 2.5 系は思考トークンもこの枠を消費するため、指定する場合は余裕を持たせること。
   */
  maxOutputTokens?: number;
}

export interface ModelResponse {
  /** JSON モードで生成された生テキスト（未パース）。 */
  text: string;
  usage: ModelUsage;
  /** 例: "gemini-2.5-flash"。監査の `model_version` 列に記録する。 */
  modelVersion: string;
}

export interface ModelClient {
  generate(req: ModelRequest): Promise<ModelResponse>;
}
