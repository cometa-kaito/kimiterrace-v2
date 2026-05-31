/**
 * F06 (#42 第1スライス): 生徒 Q&A の **入力バリデーション + スコープ拒否文言**。
 *
 * F06 受け入れ条件「スコープ外（学習・進路）の質問は誘導せず拒否」の **一次的な強制は
 * モデルの system プロンプト契約**（{@link file://./prompt.ts buildSystemPrompt}）が担う。
 * 自然言語のスコープ判定をアプリ層のキーワード一致でやると正当な掲示物質問を誤って弾く
 * （false reject）ため、ここでは **脆いキーワード分類は持たない**。
 *
 * 本モジュールが決定的に担うのは:
 * - **入力バリデーション**: 空・空白のみ・長すぎる質問を LLM 呼び出し前に弾く（コスト/濫用対策、NFR06）。
 * - **拒否文言の単一ソース**: スコープ外時にモデル応答へフォールバック表示する定型文を 1 箇所に固定し、
 *   route 層・テストが同じ文字列を参照できるようにする。
 */

/** 質問の最大文字数。掲示物 Q&A は短文想定。超長文は濫用/コスト膨張源のため LLM 前に弾く。 */
export const MAX_QUESTION_LENGTH = 500;

/**
 * スコープ外の質問への定型拒否文（誘導なし）。F06 受け入れ条件の文言。
 * モデルが万一スコープ外に答えかけた場合の route 層フォールバック、及び prefilter 拒否時に用いる。
 */
export const OUT_OF_SCOPE_REPLY = "ごめんなさい、それは掲示物の話題から外れます。";

/** {@link validateQuestion} の結果。reason は拒否理由の機械判別用。 */
export type QuestionValidation =
  | { ok: true; question: string }
  | { ok: false; reason: "empty" | "too_long" };

/**
 * 生徒の質問を LLM へ渡す前にバリデートする。前後空白を除去し、空文字・空白のみは `empty`、
 * {@link MAX_QUESTION_LENGTH} 超過は `too_long` で拒否する。境界（ちょうど上限）は許可。
 */
export function validateQuestion(raw: string): QuestionValidation {
  const question = raw.trim();
  if (question.length === 0) return { ok: false, reason: "empty" };
  if (question.length > MAX_QUESTION_LENGTH) return { ok: false, reason: "too_long" };
  return { ok: true, question };
}
