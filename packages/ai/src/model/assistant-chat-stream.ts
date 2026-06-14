import { createVertex } from "@ai-sdk/google-vertex";
import { streamObject } from "ai";
import { z } from "zod";

/**
 * 会話型 AI アシスタント（学校エディタ・finding 2b, ADR-033/036 の発展）の **構造化オブジェクト・
 * ストリーミング** Vertex Gemini アダプタ。
 *
 * 連絡ドラフト（`notice-draft-stream.ts`）は `streamObject` の **array mode**（連絡を 1 件ずつ確定）だが、
 * 会話型は **1 ターンの応答が「会話文(reply)」＋「構造化下書き(予定/連絡/提出物)」の複合**なので
 * **object mode**（`partialObjectStream` で 1 つのオブジェクトを漸進的に確定）を使う。これにより handler は
 * (a) `reply` の伸長を会話のストリーミング表示に、(b) 各セクション配列の確定をカード更新に写像できる。
 *
 * - モデルは ADR-017 のバージョンピン（既定 `gemini-2.5-flash`）。project/location は注入（asia-northeast1
 *   固定運用・NFR07 データ越境ゼロ）。認証は ADC/Workload Identity（ルール5、JSON キーファイル禁止）。
 * - **多ターン会話**: 本層は `{system, user}` の単発契約（`chat-stream.ts`/`notice-draft-stream.ts` と同形）。
 *   会話履歴・現在の下書き・基準日・許可セクションは **handler が user プロンプトに平坦化して渡す**
 *   （マスク往復を 1 回で閉じ、辞書衝突を避けるため。multi-message ではなく単一プロンプト）。
 * - **PII（ルール4）**: 本層は渡された system/user をそのままモデルへ送る。マスク/逆マスク/fail-closed は
 *   **handler（apps/web の assistant-chat-sse）の責務**（`chat-stream.ts`/`notice-draft-stream.ts` と同方針）。
 * - **ドメイン文言**（パターン準拠・捏造禁止・トーン等）は本層に持たず handler の system に載せる。スキーマは
 *   **構造のみ**を規定し、最終検証は下流の `validate*Items`（apps/web）が強制する（構造の二重指示を避ける）。
 */

/** {@link createVertexAssistantChatClient} の設定。 */
export interface VertexAssistantChatConfig {
  /** GCP プロジェクト ID。 */
  project: string;
  /** リージョン。会話型も asia-northeast1 固定運用。 */
  location: string;
  /** バージョンピンしたモデル ID。既定は {@link DEFAULT_MODEL_ID}。 */
  modelId?: string;
}

/** 既定モデル。F03/F06/F08 と揃える（ADR-017 / #289 ④）。 */
const DEFAULT_MODEL_ID = "gemini-2.5-flash";

/**
 * 1 ターンの構造化出力スキーマ（**構造のみ**）。`reply` を先頭に置き、配列より先に流れる（会話の体感速度）。
 * 各セクション要素は schedule-core / notice-assignment-core（apps/web）の検証済み型に**形だけ**合わせ、
 * 長さ・period 範囲・実在日付などの規則は下流 `validate*Items` が強制する（ドメイン規則を本層に焼かない）。
 */
const assistantTurnSchema = z.object({
  reply: z.string(),
  schedules: z.array(
    z.object({
      period: z.number(),
      subject: z.string(),
      note: z.string().optional(),
      location: z.string().optional(),
      targetAudience: z.string().optional(),
    }),
  ),
  notices: z.array(
    z.object({
      text: z.string(),
      isHighlight: z.boolean().optional(),
      displayDays: z.number().optional(),
    }),
  ),
  assignments: z.array(z.object({ deadline: z.string(), subject: z.string(), task: z.string() })),
});

/**
 * `partialObjectStream` が逐次 yield する **部分オブジェクト**。生成途中はどのフィールドも欠落/未完成
 * になりうるため、各フィールドは `unknown`（handler が `reply` を型チェックし、各配列を下流の
 * `sanitizeDraft` / `validate*Items` で検証する＝本層は緩く、検証は単一ソースに集約）。
 */
export interface AssistantTurnPartial {
  reply?: unknown;
  schedules?: unknown;
  notices?: unknown;
  assignments?: unknown;
}

/** SSE ストリーミング 1 ターン分の結果。handler がこれを meta/message/draft/done フレームに整形する。 */
export interface AssistantChatStreamResult {
  /** 1 ターンのオブジェクトを漸進的に確定する部分ストリーム（`streamObject` の `partialObjectStream`）。 */
  partialStream: AsyncIterable<AssistantTurnPartial>;
  /** 全送出後に解決。model_version + 応答（output）トークン数（監査の件数のみ記録に併用）。 */
  done: Promise<{ modelVersion: string; tokenCount: number }>;
}

/** 会話型 AI 構造化ストリームの抽象境界。 */
export interface VertexAssistantChatClient {
  stream(req: { system: string; user: string }): AssistantChatStreamResult;
}

/**
 * Vertex Gemini の構造化オブジェクト・ストリーミングクライアントを生成する。本番は Cloud Run の Workload
 * Identity で認証され、テストは `ai` `streamObject` を mock して GCP 無しで配線を検証する（ADR-012）。
 */
export function createVertexAssistantChatClient(
  config: VertexAssistantChatConfig,
): VertexAssistantChatClient {
  const vertex = createVertex({ project: config.project, location: config.location });
  const modelId = config.modelId ?? DEFAULT_MODEL_ID;

  return {
    stream(req: { system: string; user: string }): AssistantChatStreamResult {
      // streamObject(object) は同期に StreamObjectResult を返す（partialObjectStream は逐次、usage は完了後に
      // 解決する Promise）。await しない。スキーマは構造のみ、ドメイン規則は req.system が規定。
      const result = streamObject({
        model: vertex(modelId),
        schema: assistantTurnSchema,
        system: req.system,
        prompt: req.user,
      });

      const done = (async () => {
        const usage = await result.usage;
        return {
          modelVersion: modelId,
          // 監査の token_count には応答（completion/output）トークンを用いる（他アダプタと同方針）。
          tokenCount: usage?.outputTokens ?? 0,
        };
      })();

      return { partialStream: result.partialObjectStream, done };
    },
  };
}
