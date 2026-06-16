import { createVertex } from "@ai-sdk/google-vertex";
import { streamObject } from "ai";
import { z } from "zod";
import {
  DRAFT_TEMPERATURE,
  type GenerationTuning,
  mergeTuning,
  toGenerationOptions,
} from "./generation-tuning.js";

/**
 * エディタ AI 連絡ドラフト（#243 ②UI-UX, ADR-033）の **構造化リスト・ストリーミング** Vertex Gemini
 * アダプタ。
 *
 * F06 生徒対話の `chat-stream.ts`（`streamText` で **prose トークン** を逐次返す）と同じ依存逆転・
 * バージョンピン・ADC 認証を踏襲しつつ、**出力形状が違う**: 連絡は「短文の独立した複数件」なので
 * トークン列ではなく **構造化オブジェクトを 1 件ずつ確定ストリーミング** する（Vercel AI SDK
 * `streamObject` の array mode `elementStream`）。これにより UI は (a) 送信直後にスケルトンを N 枚出し
 * (b) 各連絡が完成するたびカードを反転させ (c) 完成した項目から個別に採用できる（ADR-033 / 設計 §2.1）。
 *
 * - モデルは ADR-017 のバージョンピン（既定 `gemini-2.5-flash`、#289 ④で旧 1.5 Pro retired により更新）。
 *   project / location はハードコードせず注入（asia-northeast1 固定運用、NFR07 データ越境ゼロ）。
 * - 認証は ADC / Workload Identity（CLAUDE.md ルール5、JSON キーファイル禁止）。`@ai-sdk/google-vertex`
 *   が google-auth-library 経由で ADC を解決する。
 * - **PII（ルール4）**: 本アダプタは渡された system/user プロンプトをそのままモデルへ送る。生 PII の
 *   マスキング、および逆マスク後の **要素単位 fail-closed 検査** は **呼び出し側（apps/web の SSE handler）の
 *   責務**であり、本層は既にマスク済プロンプトを受け取る契約（`chat-stream.ts` / `vertex.ts` と同方針）。
 * - **連絡本文の文言ルール**（1 文・字数・相対日付解決・個人名/事実を創作しない 等）は本層に持たず、
 *   呼び出し側が `system` プロンプトに載せる（スキーマは構造のみ規定、ドメイン文言はアプリ層に局在）。
 */

/** {@link createVertexNoticeStreamClient} の設定。 */
export interface VertexNoticeStreamConfig {
  /** GCP プロジェクト ID。 */
  project: string;
  /** リージョン。連絡ドラフトも asia-northeast1 固定運用。 */
  location: string;
  /** バージョンピンしたモデル ID。既定は {@link DEFAULT_MODEL_ID}（ADR-017 / #289 ④）。 */
  modelId?: string;
  /**
   * 生成パラメータの上書き（任意）。未指定フィールドはクライアント既定（{@link DEFAULT_TUNING}）に従う。
   * 配線層が env から thinking budget 等を注入できるよう外出しする（#593）。
   */
  tuning?: GenerationTuning;
}

/** ストリーミングで 1 件ずつ確定する連絡ドラフト要素（array mode の要素型）。 */
export interface NoticeDraftElement {
  /** 連絡本文（1 文の簡潔な日本語）。文言ルールは呼び出し側の system プロンプトが規定。 */
  text: string;
  /** 重要な注意喚起なら true（通常は false）。 */
  isHighlight: boolean;
}

/** SSE ストリーミング 1 リクエスト分の結果。handler 層がこれを `notice` フレームに整形する。 */
export interface NoticeDraftStreamResult {
  /** 確定した連絡要素を 1 件ずつ yield（`streamObject` array mode の `elementStream`）。 */
  elementStream: AsyncIterable<NoticeDraftElement>;
  /**
   * 全要素送出後に解決する。バージョンピンした model_version + 応答（output）トークン数を返し、
   * 監査記録（件数のみ・本文は残さない、ルール1/4）に用いる。
   */
  done: Promise<{ modelVersion: string; tokenCount: number }>;
}

/** 連絡ドラフト構造化ストリームの抽象境界。 */
export interface VertexNoticeStreamClient {
  stream(req: { system: string; user: string }): NoticeDraftStreamResult;
}

/** 既定モデル。F03/F06/F08 と揃える（ADR-017 / #289 ④: 旧 1.5 Pro retired → Flash tier に更新）。 */
const DEFAULT_MODEL_ID = "gemini-2.5-flash";

/**
 * 連絡ドラフトの既定生成パラメータ。温度は忠実寄り（{@link DRAFT_TEMPERATURE}）、出力上限は短文連絡を
 * 複数件賄える 1024。thinking budget は既定 SDK dynamic（配線層が env で絞れる）。
 */
const DEFAULT_TUNING: GenerationTuning = {
  temperature: DRAFT_TEMPERATURE,
  maxOutputTokens: 1024,
};

/**
 * 連絡 1 件分の構造化スキーマ（array mode の要素型）。**構造のみ**を規定し、文言（字数・トーン・
 * 相対日付解決 等）は呼び出し側の system プロンプトに委ねる（ドメイン文言をアダプタに焼かない）。
 */
const noticeElementSchema = z.object({
  text: z.string(),
  isHighlight: z.boolean(),
});

/**
 * Vertex Gemini の構造化リスト・ストリーミングクライアントを生成する。本番は Cloud Run の Workload
 * Identity で認証され、テストは `ai` `streamObject` を mock して GCP 無しで配線を検証する（ADR-012）。
 */
export function createVertexNoticeStreamClient(
  config: VertexNoticeStreamConfig,
): VertexNoticeStreamClient {
  const vertex = createVertex({ project: config.project, location: config.location });
  const modelId = config.modelId ?? DEFAULT_MODEL_ID;
  // 既定（忠実寄り温度 + 出力上限）に呼び出し側 tuning をフィールド単位で重ねる（env 由来の thinking 等）。
  const genOptions = toGenerationOptions(mergeTuning(DEFAULT_TUNING, config.tuning));

  return {
    stream(req: { system: string; user: string }): NoticeDraftStreamResult {
      // streamObject(array) は同期に StreamObjectResult を返す（elementStream は逐次、usage は完了後に
      // 解決する Promise）。await しない。output:"array" + 要素スキーマで「連絡の配列」を 1 件ずつ流す。
      const result = streamObject({
        model: vertex(modelId),
        output: "array",
        schema: noticeElementSchema,
        system: req.system,
        prompt: req.user,
        // 生成パラメータ（temperature / maxOutputTokens / providerOptions.thinkingConfig）。創作抑制・
        // 暴走防止・レイテンシ調整（generation-tuning）。未指定キーは生やさず SDK 既定を尊重。
        ...genOptions,
      });

      const done = (async () => {
        const usage = await result.usage;
        return {
          modelVersion: modelId,
          // 監査の token_count には応答（completion/output）トークンを用いる（chat-stream と同方針、
          // SDK v5 の usage は input/output 命名）。
          tokenCount: usage?.outputTokens ?? 0,
        };
      })();

      return { elementStream: result.elementStream, done };
    },
  };
}
