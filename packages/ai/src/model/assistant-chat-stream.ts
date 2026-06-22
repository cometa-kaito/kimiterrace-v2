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
  /**
   * 生成パラメータの上書き（任意）。未指定フィールドはクライアント既定（{@link DEFAULT_TUNING}）に従う。
   * 配線層が env から thinking budget 等を注入できるよう外出しする（#593）。
   */
  tuning?: GenerationTuning;
}

/** 既定モデル。F03/F06/F08 と揃える（ADR-017 / #289 ④）。 */
const DEFAULT_MODEL_ID = "gemini-2.5-flash";

/**
 * 会話アシスタントの既定生成パラメータ。温度は忠実寄り（{@link DRAFT_TEMPERATURE}）。出力上限は
 * 「会話応答 + 1 ターン分の構造化下書き」に加え、**複数日まとめ（`days`）の下書き**（来週分の予定を
 * 一度に作る等）が途中で途切れないよう 4096 に取る（上限は CAP であり単一日生成のコスト/レイテンシは
 * 実出力トークンに比例して不変・複数日のときだけ消費が増える）。thinking budget は既定 SDK dynamic
 * （配線層が env で絞れる。prod は GEMINI_THINKING_BUDGET=0 で思考が出力枠を食わない）。
 */
const DEFAULT_TUNING: GenerationTuning = {
  temperature: DRAFT_TEMPERATURE,
  maxOutputTokens: 4096,
};

/**
 * 各セクションの要素スキーマ（**構造のみ**）。top-level（その日 1 日分）と `days[]`（複数日まとめ）の
 * 双方で同じ形を使う（DRY）。長さ・period 範囲・実在日付などの規則は下流 `validate*Items`（apps/web）が
 * 強制する（ドメイン規則を本層に焼かない）。
 */
const scheduleArray = z.array(
  z.object({
    period: z.number(),
    subject: z.string(),
    note: z.string().optional(),
    location: z.string().optional(),
    targetAudience: z.string().optional(),
  }),
);
const noticeArray = z.array(
  z.object({
    text: z.string(),
    isHighlight: z.boolean().optional(),
    displayDays: z.number().optional(),
  }),
);
const assignmentArray = z.array(
  z.object({ deadline: z.string(), subject: z.string(), task: z.string() }),
);

/**
 * 1 ターンの構造化出力スキーマ（**構造のみ**）。`reply` を先頭に置き、配列より先に流れる（会話の体感速度）。
 *
 * - top-level の `schedules/notices/assignments` = **その日 1 日分**の下書き（従来どおり・単一日の最頻出経路）。
 * - `days` = **複数日まとめ**の下書き（「来週月〜金の予定」等）。各要素は対象日（`date`: YYYY-MM-DD・handler が
 *   基準日から実在日付に解決させる）＋同じ 3 セクション。単一日では空/省略（モデルへの指示は handler の system）。
 *   どの日に何件入れるかはプロンプトが規定し、実在日付・件数上限の強制は下流 `sanitizeDraft`（apps/web）が担う。
 */
const assistantTurnSchema = z.object({
  reply: z.string(),
  schedules: scheduleArray,
  notices: noticeArray,
  assignments: assignmentArray,
  days: z
    .array(
      z.object({
        date: z.string(),
        schedules: scheduleArray,
        notices: noticeArray,
        assignments: assignmentArray,
      }),
    )
    .optional(),
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
  /** 複数日まとめの下書き（生成途中は欠落/未完成になりうる。handler が下流 `sanitizeDraft` で検証）。 */
  days?: unknown;
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
  /**
   * `signal` は無応答/ストール時に handler が Vertex 呼び出しを能動的に中断するための AbortSignal（任意）。
   * abort されると `partialStream` / `done` が reject し、handler が `stream_failed` に畳む（本番ハング対策）。
   */
  stream(req: { system: string; user: string; signal?: AbortSignal }): AssistantChatStreamResult;
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
  // 既定（忠実寄り温度 + 出力上限）に呼び出し側 tuning をフィールド単位で重ねる（env 由来の thinking 等）。
  const genOptions = toGenerationOptions(mergeTuning(DEFAULT_TUNING, config.tuning));

  return {
    stream(req: { system: string; user: string; signal?: AbortSignal }): AssistantChatStreamResult {
      // streamObject(object) は同期に StreamObjectResult を返す（partialObjectStream は逐次、usage は完了後に
      // 解決する Promise）。await しない。スキーマは構造のみ、ドメイン規則は req.system が規定。
      const result = streamObject({
        model: vertex(modelId),
        schema: assistantTurnSchema,
        system: req.system,
        prompt: req.user,
        // 無応答/ストール時に handler が中断できるよう abort を配線（assistant-chat-sse のストール監視）。
        // 未指定なら付与しない（既定挙動を変えない）。
        ...(req.signal ? { abortSignal: req.signal } : {}),
        // 生成パラメータ（temperature / maxOutputTokens / providerOptions.thinkingConfig）。創作抑制・
        // 暴走防止・レイテンシ調整（generation-tuning）。未指定キーは生やさず SDK 既定を尊重。
        ...genOptions,
      });

      const done = (async () => {
        const usage = await result.usage;
        return {
          modelVersion: modelId,
          // 監査の token_count には応答（completion/output）トークンを用いる（他アダプタと同方針）。
          tokenCount: usage?.outputTokens ?? 0,
        };
      })();
      // 中断（abortSignal）や mid-stream 障害では `result.usage` が reject する。handler が partialStream の
      // throw で先に catch へ抜け `done` を await しない経路（ストール中断等）でも unhandledRejection を出さない
      // よう、no-op handler を 1 つ付けておく（戻り値の `done` は引き続き呼び出し側が await して値を取れる）。
      done.catch(() => {});

      return { partialStream: result.partialObjectStream, done };
    },
  };
}
