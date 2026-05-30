import { createVertex } from "@ai-sdk/google-vertex";
import { generateText } from "ai";
import type { ModelClient, ModelRequest, ModelResponse } from "./client.js";

/**
 * Vertex AI Gemini アダプタ（ADR-005 Vertex AI / ADR-006 Vercel AI SDK / ADR-017）。
 *
 * - モデルは Gemini Pro 固定・バージョンピン（ADR-017 決定1、`gemini-1.5-pro-002`）。
 * - 認証は ADC / Workload Identity（CLAUDE.md ルール5、JSON キーファイル禁止）。
 *   `@ai-sdk/google-vertex` は google-auth-library 経由で ADC を解決するため、本番 Cloud Run では
 *   Workload Identity がそのまま効き、ローカルは `gcloud auth application-default login` で賄える。
 * - native JSON モードを `responseMimeType` で要求しつつ、parse / Zod validate / リトライは
 *   オーケストレータ側に委ねる（このアダプタは生テキストを返すだけ）。
 *
 * リージョンは asia-northeast1（データ越境ゼロ、NFR07）。project/location はハードコードせず注入。
 */

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
        model: vertex(modelId),
        system: req.system,
        prompt: req.user,
        providerOptions: { google: { responseMimeType: "application/json" } },
      });
      const usage = result.usage;
      return {
        text: result.text,
        usage: {
          promptTokens: usage?.promptTokens ?? 0,
          completionTokens: usage?.completionTokens ?? 0,
          totalTokens: usage?.totalTokens ?? 0,
        },
        modelVersion: modelId,
      };
    },
  };
}
