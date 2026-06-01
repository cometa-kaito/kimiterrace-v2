import { createVertex } from "@ai-sdk/google-vertex";
import { generateText } from "ai";
import { type EffectCommentStats, buildEffectCommentPrompt } from "../prompt/effect-comment.js";
import type { ModelClient, ModelRequest, ModelResponse, ModelUsage } from "./client.js";

/**
 * F08 (#44, ADR-005/006) AI 効果コメント生成のモデル呼び出し層。
 *
 * slice 1 (#443) の決定論的プロンプト builder (`buildEffectCommentPrompt`) を実 Gemini 呼び出しに
 * 繋ぐ「欠落リンク」。F03 の `vertex.ts` と同じ依存逆転（`ModelClient` 抽象 + Vertex アダプタ +
 * テストは fake 注入で GCP 不要、ADR-012）を踏襲するが、**JSON モードを強制しない**点が決定的に
 * 異なる: F03 抽出は構造化 JSON を返させるのに対し、効果コメントは校長/教員が読む**自然文の散文**で
 * あり、`responseFormat: json` を課すと出力が壊れる。よって `forceJsonResponseMiddleware` は使わず
 * 素の `generateText` を呼ぶ。
 *
 * 永続化（effect_comments テーブル）と月次バッチ entrypoint は packages/db / apps/jobs の後続スライス。
 * 本スライスは packages/ai に閉じる（builder → モデル呼び出し → コメント文字列）。
 */

export interface EffectCommentModelConfig {
  /** GCP プロジェクト ID（例: signage-v2-prod）。 */
  project: string;
  /** リージョン。F08 も asia-northeast1 固定運用（NFR07 データ越境ゼロ）。 */
  location: string;
  /** バージョンピンしたモデル ID。既定は ADR-017 の Gemini Pro。 */
  modelId?: string;
}

/** 既定モデル。F03 と揃える（ADR-017 Gemini Pro ピン）。月次・低頻度バッチのため Pro で可。 */
const DEFAULT_MODEL_ID = "gemini-1.5-pro-002";

/**
 * テキストモード（非 JSON）の Vertex Gemini アダプタ。`createVertexModelClient`（vertex.ts）と異なり
 * `responseFormat` を注入しない = 自然文出力。認証は ADC / Workload Identity（ルール5、JSON キー禁止）。
 * project / location はハードコードせず注入する。
 */
export function createVertexEffectCommentClient(config: EffectCommentModelConfig): ModelClient {
  const vertex = createVertex({ project: config.project, location: config.location });
  const modelId = config.modelId ?? DEFAULT_MODEL_ID;

  return {
    async generate(req: ModelRequest): Promise<ModelResponse> {
      const result = await generateText({
        model: vertex(modelId),
        system: req.system,
        prompt: req.user,
      });
      const usage = result.usage;
      return {
        text: result.text,
        usage: {
          // v5 で usage フィールドがリネーム（input/output→prompt/completion）。vertex.ts と同方針で
          // SDK 側のフィールド名のみ追従し、自前 ModelResponse.usage は据え置く。
          promptTokens: usage?.inputTokens ?? 0,
          completionTokens: usage?.outputTokens ?? 0,
          totalTokens: usage?.totalTokens ?? 0,
        },
        modelVersion: modelId,
      };
    },
  };
}

/** {@link generateEffectComment} の結果。usage / modelVersion は監査（ルール4 / NFR04）記録用。 */
export interface EffectCommentResult {
  /** 生成された自然文コメント（trim 済・非空）。 */
  comment: string;
  usage: ModelUsage;
  /** 監査の `model_version` 列に記録するモデル ID。 */
  modelVersion: string;
}

/** 効果コメントが空（モデルが本文を返さなかった）場合に投げる。バッチは空コメントを保存しない。 */
export class EmptyEffectCommentError extends Error {
  constructor() {
    super("effect comment model returned empty text");
    this.name = "EmptyEffectCommentError";
  }
}

/**
 * 月次集計 `stats` から効果コメントを 1 件生成する。プロンプト構築は決定論的 builder に委ね、本関数は
 * 「builder → モデル呼び出し → trim / 非空検証」のオーケストレーションのみを担う。
 *
 * `client` は抽象 `ModelClient`。本番は {@link createVertexEffectCommentClient}、テストは fake を注入する
 * （GCP 資格情報なしで検証可能、ADR-012）。`stats.topContent[].title` は呼び出し側で maskPII 済である
 * 契約（ルール4、{@link buildEffectCommentPrompt} の前提）を本層も前提とし、生 PII を渡さない。
 */
export async function generateEffectComment(
  client: ModelClient,
  stats: EffectCommentStats,
): Promise<EffectCommentResult> {
  const prompt = buildEffectCommentPrompt(stats);
  const res = await client.generate({ system: prompt.system, user: prompt.user });
  const comment = res.text.trim();
  if (comment.length === 0) {
    throw new EmptyEffectCommentError();
  }
  return { comment, usage: res.usage, modelVersion: res.modelVersion };
}
