import { createVertex } from "@ai-sdk/google-vertex";
import { type LanguageModelMiddleware, generateText, wrapLanguageModel } from "ai";
import type { ModelClient, ModelRequest, ModelResponse } from "./client.js";

/**
 * Vertex AI Gemini アダプタ（ADR-005 Vertex AI / ADR-006 Vercel AI SDK / ADR-017）。
 *
 * - モデルは Gemini Pro 固定・バージョンピン（ADR-017 決定1、`gemini-1.5-pro-002`）。
 * - 認証は ADC / Workload Identity（CLAUDE.md ルール5、JSON キーファイル禁止）。
 *   `@ai-sdk/google-vertex` は google-auth-library 経由で ADC を解決するため、本番 Cloud Run では
 *   Workload Identity がそのまま効き、ローカルは `gcloud auth application-default login` で賄える。
 * - native JSON モードを要求しつつ、parse / Zod validate / リトライはオーケストレータ側に委ねる
 *   （このアダプタは生 JSON テキストを返すだけ）。
 *
 * リージョンは asia-northeast1（データ越境ゼロ、NFR07）。project/location はハードコードせず注入。
 */

/**
 * native JSON モード（Vertex の `responseMimeType: "application/json"`）を強制するミドルウェア。
 *
 * ai SDK v4 では `providerOptions.google.responseMimeType` で直接指定できたが、v5 + `@ai-sdk/google`
 * v2 ではこのキーが型・実挙動とも廃止された。v5 では provider が `LanguageModelV2CallOptions.
 * responseFormat.type === "json"` を受けて `responseMimeType` を自動付与する設計に変わったが、
 * `generateText` はこの `responseFormat` を公開引数に持たない（`generateObject` 専用）。
 * schema を強制せず生テキストを返す方針（parse はオーケストレータ側）を維持するため、
 * `wrapLanguageModel` の `transformParams` で `responseFormat` のみを注入する。
 */
const forceJsonResponseMiddleware: LanguageModelMiddleware = {
  transformParams: async ({ params }) => ({
    ...params,
    responseFormat: { type: "json" },
  }),
};

export interface VertexModelConfig {
  /** GCP プロジェクト ID（例: signage-v2-prod）。 */
  project: string;
  /** リージョン。F03 は asia-northeast1 固定運用。 */
  location: string;
  /** バージョンピンしたモデル ID。既定は ADR-017 の Gemini Pro。 */
  modelId?: string;
}

const DEFAULT_MODEL_ID = "gemini-1.5-pro-002";

export function createVertexModelClient(config: VertexModelConfig): ModelClient {
  const vertex = createVertex({ project: config.project, location: config.location });
  const modelId = config.modelId ?? DEFAULT_MODEL_ID;

  return {
    async generate(req: ModelRequest): Promise<ModelResponse> {
      const result = await generateText({
        // native JSON モードはミドルウェア（forceJsonResponseMiddleware）で responseFormat を注入。
        // 詳細は同ミドルウェアの doc コメント参照。
        model: wrapLanguageModel({
          model: vertex(modelId),
          middleware: forceJsonResponseMiddleware,
        }),
        system: req.system,
        prompt: req.user,
      });
      const usage = result.usage;
      return {
        text: result.text,
        usage: {
          // v5 で usage フィールドがリネーム: promptTokens→inputTokens /
          // completionTokens→outputTokens（totalTokens は不変）。自前 ModelResponse.usage は
          // 内部 API のため据え置き、SDK 側から読むフィールド名のみ追従。
          promptTokens: usage?.inputTokens ?? 0,
          completionTokens: usage?.outputTokens ?? 0,
          totalTokens: usage?.totalTokens ?? 0,
        },
        modelVersion: modelId,
      };
    },
  };
}
