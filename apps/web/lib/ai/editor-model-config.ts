import type { GenerationTuning } from "@kimiterrace/ai";

/**
 * Editor AI（連絡ドラフト / 会話アシスタント）の Vertex クライアントへ渡す **env 由来の設定**を解決する。
 *
 * これまで model ID は `gemini-2.5-flash` ハードコード、生成パラメータは未設定だった。本ヘルパで
 * **運用（env）から差し替え可能**にする（STATUS #593 follow-up「モデル ID env 化」「thinking-budget tuning」）:
 *
 * - `GEMINI_MODEL`: バージョンピンしたモデル ID。未設定なら `undefined`（クライアント既定 `gemini-2.5-flash`）。
 *   モデル更新（retired 等）をコード変更なしで反映できる（#289 ④ で 1.5 Pro retired を踏んだ教訓）。
 * - `GEMINI_THINKING_BUDGET`: Gemini 2.5 の思考トークン上限。`0` で思考無効化、未設定/不正なら `undefined`
 *   （SDK 既定 dynamic）。構造化下書きのレイテンシ/コストを実トラフィックで計測しながら絞るための knob。
 *
 * 温度・出力上限は**安全寄りの既定をクライアント側（packages/ai）でコードに焼く**ため、ここでは扱わない
 * （env を最小限に保つ）。tuning が空（env 未設定）なら `tuning` は `undefined` を返し、クライアント既定に委ねる。
 *
 * 両 editor 系統（assistant-chat-sse / notice-draft-sse）の `getStreamClient` が本ヘルパを共有し、
 * pattern→セクションと同様に **単一ソース**で env を解釈する（二重化＝ドリフト回避）。
 */

/** 非負整数の env を読む（未設定・空・非数・負数は undefined）。`0` は有効値として通す。 */
function readNonNegativeInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    return undefined;
  }
  return n;
}

/** Editor AI Vertex クライアントの env 由来設定（model ID + 生成 tuning）。 */
export interface EditorModelConfig {
  /** `GEMINI_MODEL`。未設定なら undefined（クライアント既定にフォールバック）。 */
  modelId?: string;
  /** env 由来の生成 tuning。env 未設定なら undefined（クライアント既定にフォールバック）。 */
  tuning?: GenerationTuning;
}

/** env から Editor AI クライアント設定を解決する（純粋に `process.env` を読むだけ）。 */
export function resolveEditorModelConfig(): EditorModelConfig {
  const modelRaw = process.env.GEMINI_MODEL?.trim();
  const modelId = modelRaw ? modelRaw : undefined;

  const thinkingBudget = readNonNegativeInt("GEMINI_THINKING_BUDGET");
  const tuning: GenerationTuning | undefined =
    thinkingBudget !== undefined ? { thinkingBudget } : undefined;

  return { modelId, tuning };
}
