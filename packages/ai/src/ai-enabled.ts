/**
 * 実 Vertex AI のグローバル kill-switch（**既定 OFF**、ルール4 / ADR-030、#289 / #593）。
 *
 * 実 Vertex（Gemini 生成 / embedding）を呼ぶ **すべての入口** を、環境変数 `AI_ENABLED` が明示的に
 * `"true"` の時だけ通す。未設定・空文字・`"false"`・その他の値はすべて **無効**（fail-safe = 既定で AI OFF）。
 * これにより PII マスキング設計（ADR-030）と `aiplatform.googleapis.com` 有効化の検証が済むまで、
 * 「AI が制御無しで on になる窓」を作らない（#289 の受入ゲート）。
 *
 * ## なぜ @kimiterrace/ai に置くか（共有プリミティブ）
 * 実 Vertex を呼ぶ層は apps/web（route / Server Action）と apps/jobs（embedding バッチ）の **両デプロイ単位**
 * に跨る。kill-switch を Vertex クライアントを実際に組み立てる本パッケージに 1 箇所だけ置き、各入口がこれを
 * 参照することで、AI を on にする env 条件の単一ソースを保つ（apps/web は別途自パッケージにも薄い写しを持つが、
 * セマンティクスは本モジュールと一致）。
 *
 * ## 使い方
 * - route / action / job entrypoint 等、graceful に「無効」を表現できる境界では {@link isAiEnabled} を見て
 *   503 / disabled / skip を返す。
 * - graceful 写像ができない深い経路では {@link assertAiEnabled} で {@link AiDisabledError} を投げる
 *   （多層防御の防御的プリミティブ）。
 */

/** `AI_ENABLED === "true"` の時だけ true。未設定/空/その他の値は false（既定 OFF = fail-safe）。 */
export function isAiEnabled(): boolean {
  return process.env.AI_ENABLED === "true";
}

/** AI が無効な状態で Vertex 経路に入ったことを表すエラー（深い経路の防御的 assert 用）。 */
export class AiDisabledError extends Error {
  constructor() {
    super("AI features are disabled (AI_ENABLED is not 'true').");
    this.name = "AiDisabledError";
  }
}

/**
 * AI が無効なら {@link AiDisabledError} を投げる防御的プリミティブ。
 *
 * 入口境界では graceful に 503 / disabled / skip を返したいので {@link isAiEnabled} を使う。
 * 本関数は graceful 写像ができない深い経路（将来の追加層）向けの多層防御 API。
 */
export function assertAiEnabled(): void {
  if (!isAiEnabled()) {
    throw new AiDisabledError();
  }
}
