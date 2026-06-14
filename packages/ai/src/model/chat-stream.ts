import { createVertex } from "@ai-sdk/google-vertex";
import { streamText } from "ai";

/**
 * F06 (#42 / #373, ADR-005 Vertex AI / ADR-006 Vercel AI SDK): 生徒対話 Q&A の **SSE
 * ストリーミング** Vertex Gemini アダプタ。
 *
 * `vertex.ts` (`createVertexModelClient`、JSON 一括生成) と同じ依存逆転を踏襲しつつ、**逐次
 * ストリーミング** (`streamText`) を返す点が異なる。生徒チャットは
 * 体感速度のため token を逐次表示する (SSE) ので一括 `generateText` ではなくストリームを使う。
 *
 * - モデルは ADR-017 のバージョンピン (既定 `gemini-2.5-flash`、#289 ④ で旧 1.5 Pro retired により更新)。project / location
 *   はハードコードせず注入 (リージョンは asia-northeast1 固定運用、NFR07 データ越境ゼロ)。
 * - 認証は ADC / Workload Identity (CLAUDE.md ルール5、JSON キーファイル禁止)。`@ai-sdk/google-vertex`
 *   が google-auth-library 経由で ADC を解決する。
 * - **PII (ルール4)**: 本アダプタは渡された system/user プロンプトをそのままモデルへ送る。生 PII の
 *   マスキングは **呼び出し側 (apps/web の chat-service `executeChat`) の責務**であり、本層は既に
 *   マスク済のプロンプトを受け取る契約 (`vertex.ts` と同方針、ここでは検証しない)。
 */

/** {@link createVertexChatStreamClient} の設定。 */
export interface VertexChatStreamConfig {
  /** GCP プロジェクト ID。 */
  project: string;
  /** リージョン。F06 も asia-northeast1 固定運用。 */
  location: string;
  /** バージョンピンしたモデル ID。既定は {@link DEFAULT_MODEL_ID}（ADR-017 / #289 ④）。 */
  modelId?: string;
}

/** SSE ストリーミング 1 リクエスト分の結果。route 層がこれを `data: ...\n\n` フレームに整形する。 */
export interface ChatStreamResult {
  /** 逐次チャンク (delta) の async iterable。route が消費しながら SSE で送出する。 */
  textStream: AsyncIterable<string>;
  /**
   * 全チャンク送出後に解決する。フル本文 + model_version + 応答 (output) トークン数を返し、
   * 永続化 (assistant メッセージ) と監査記録に用いる。
   */
  done: Promise<{ fullText: string; modelVersion: string; tokenCount: number }>;
}

/** 生徒対話 SSE の Vertex ストリームクライアント抽象境界。 */
export interface VertexChatStreamClient {
  stream(req: { system: string; user: string }): ChatStreamResult;
}

/** 既定モデル。F03/F08 と揃える (ADR-017 / #289 ④: 旧 1.5 Pro retired → Flash tier に更新)。 */
const DEFAULT_MODEL_ID = "gemini-2.5-flash";

/**
 * Vertex Gemini の SSE ストリーミングクライアントを生成する。本番は Cloud Run の Workload Identity
 * で認証され、テストは `ai` `streamText` を mock して GCP 無しで配線を検証する (ADR-012)。
 */
export function createVertexChatStreamClient(
  config: VertexChatStreamConfig,
): VertexChatStreamClient {
  const vertex = createVertex({ project: config.project, location: config.location });
  const modelId = config.modelId ?? DEFAULT_MODEL_ID;

  return {
    stream(req: { system: string; user: string }): ChatStreamResult {
      // streamText は同期に StreamTextResult を返す (textStream は逐次、text/usage は完了後に解決する
      // Promise)。await しない。
      const result = streamText({
        model: vertex(modelId),
        system: req.system,
        prompt: req.user,
      });

      const done = (async () => {
        const [fullText, usage] = await Promise.all([result.text, result.usage]);
        return {
          fullText,
          modelVersion: modelId,
          // assistant メッセージの token_count には応答 (completion/output) トークンを用いる。
          // v5 で usage は input/output 命名 (vertex.ts と同方針で SDK 側のフィールド名に追従)。
          tokenCount: usage?.outputTokens ?? 0,
        };
      })();

      return { textStream: result.textStream, done };
    },
  };
}
