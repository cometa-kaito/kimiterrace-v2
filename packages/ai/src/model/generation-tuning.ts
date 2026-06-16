/**
 * Editor AI（連絡ドラフト / 会話アシスタント）の Vertex **生成パラメータ**チューニング（ADR-005/006/017）。
 *
 * これまで `streamObject` / `streamText` には `temperature` / `maxOutputTokens` / thinking を **一切渡して
 * おらず**、Gemini 既定（`temperature ≈ 1.0`・dynamic thinking）で動いていた。掲示物の下書きは
 * 「**入力に無い事実・日付・氏名を創作しない**」ことが安全要件（CLAUDE.md ルール4 / 各 system プロンプト）
 * なので、既定を **低温度（忠実寄り）** に寄せ、出力長に安全上限を設け、thinking budget を運用で調整可能に
 * する。これは生成品質（創作抑制）・レイテンシ・コストの 3 点を同時に改善する（#593 thinking-budget tuning）。
 *
 * 本モジュールは **純データ写像のみ**（Vertex/SDK 非依存・テスト可能）。実際の適用は各 stream client が
 * 行い、PII マスキング等の責務境界は不変（chat-stream / notice-draft / assistant-chat と同方針）。
 */

/** Editor AI の Vertex 生成パラメータ。未指定フィールドは SDK / クライアント既定に従う。 */
export interface GenerationTuning {
  /** サンプリング温度。低いほど忠実・決定論的（創作抑制）。既定 {@link DRAFT_TEMPERATURE}。 */
  temperature?: number;
  /** 応答（出力）トークンの上限。暴走防止のための安全上限（クライアントが既定を与える）。 */
  maxOutputTokens?: number;
  /**
   * Gemini 2.5 の思考（thinking）トークン上限。`0` で思考を無効化、`undefined` で SDK 既定（dynamic）。
   * 構造化下書きはスキーマが明確でレイテンシ命のため、運用（env）で絞れるよう外出しする。値の確定は
   * 実トラフィックでの計測後（#593 thinking-budget tuning）。
   */
  thinkingBudget?: number;
}

/**
 * 掲示物下書きの既定温度。事実忠実性（創作抑制）のため低めに固定する（CLAUDE.md ルール4 / ADR-017）。
 * Gemini 既定の `≈1.0` は構造化下書きには高すぎ、日付・時限・氏名などを創作しやすい。
 */
export const DRAFT_TEMPERATURE = 0.3;

/** `streamObject` / `streamText` に重ねる追加オプション（写像結果）。 */
export interface GenerationOptions {
  temperature?: number;
  maxOutputTokens?: number;
  providerOptions?: {
    google: { thinkingConfig: { thinkingBudget: number; includeThoughts: boolean } };
  };
}

/**
 * {@link GenerationTuning} を `streamObject` / `streamText` の追加オプションへ写像する。
 *
 * - `temperature` / `maxOutputTokens` はトップレベル引数（Vercel AI SDK v5 共通）。
 * - `thinkingBudget` は `@ai-sdk/google-vertex` の `providerOptions.google.thinkingConfig`
 *   （`embed.ts` の `outputDimensionality` と同経路）。`includeThoughts: false` で思考トークンは応答に
 *   含めない（出力は構造のみ）。
 *
 * 未指定フィールドは **キー自体を生やさない**（SDK 既定を尊重し、`undefined` を明示注入しない）。
 */
export function toGenerationOptions(tuning: GenerationTuning): GenerationOptions {
  const out: GenerationOptions = {};
  if (tuning.temperature !== undefined) {
    out.temperature = tuning.temperature;
  }
  if (tuning.maxOutputTokens !== undefined) {
    out.maxOutputTokens = tuning.maxOutputTokens;
  }
  if (tuning.thinkingBudget !== undefined) {
    out.providerOptions = {
      google: { thinkingConfig: { thinkingBudget: tuning.thinkingBudget, includeThoughts: false } },
    };
  }
  return out;
}

/**
 * クライアント既定の tuning に呼び出し側 tuning を **フィールド単位で上書き** マージする
 * （`{ ...defaults, ...override }` だが `override` の `undefined` フィールドは defaults を潰さない）。
 */
export function mergeTuning(
  defaults: GenerationTuning,
  override: GenerationTuning | undefined,
): GenerationTuning {
  if (!override) {
    return { ...defaults };
  }
  const merged: GenerationTuning = { ...defaults };
  if (override.temperature !== undefined) merged.temperature = override.temperature;
  if (override.maxOutputTokens !== undefined) merged.maxOutputTokens = override.maxOutputTokens;
  if (override.thinkingBudget !== undefined) merged.thinkingBudget = override.thinkingBudget;
  return merged;
}
