/**
 * #289 (#154 follow-up): 実 Vertex AI のグローバル kill-switch（**既定 OFF**、ルール4 / ADR-030）。
 *
 * 実 Vertex（Gemini 生成 / embedding）を呼ぶ **すべての入口** を、環境変数 `AI_ENABLED` が明示的に
 * `"true"` の時だけ通す。未設定・空文字・`"false"`・その他の値はすべて **無効**（fail-safe = 既定で AI OFF）。
 * これにより PII マスキング設計（ADR-030）と `aiplatform.googleapis.com` 有効化の検証が済むまで、
 * 「AI が制御無しで on になる窓」を作らない（#289 の受入ゲート）。
 *
 * ## 入口（本 switch でゲートする Vertex 呼び出し境界）
 * - F03 教員入力 AI 抽出: `POST /api/teacher-inputs/:id/extract`（route POST 冒頭で 503）
 * - F06 生徒/教員 Q&A チャット: `respondWithChatStream`（生徒・教員 両 route の単一 choke point で 503）
 *   ※ F08 効果コメント生成は #902（§43）で self-school ダッシュボード retire に伴い撤去（旧入口削除）。
 *   ※ F06 embedding バッチ（apps/jobs / cloud_run_job）は別デプロイ単位で現状 enabled=false。
 *     当該 Job を有効化する際に AI_ENABLED を併せて配線すること（本 PR の範囲外・follow-up）。
 *
 * ## なぜ route/action 境界で使うか（model getter には置かない）
 * model getter（`getExtractionModel` 等）は Server Action のデフォルト引数
 * （`deps = defaultDeps()`）で評価されるため、そこで throw すると try/catch の **外** で
 * 500 化し、既存テストも壊れる。よって gate は **ハンドラ本体の冒頭** で {@link isAiEnabled} を見て
 * graceful に 503 / disabled を返す（本モジュールの想定使用）。{@link assertAiEnabled} は graceful 写像が
 * できない深い経路向けの防御的プリミティブ（多層防御 API）。
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
 * route/action 境界では graceful に 503 / disabled を返したいので {@link isAiEnabled} を使う。
 * 本関数は graceful 写像ができない深い経路（将来の追加層）向けの多層防御 API。
 */
export function assertAiEnabled(): void {
  if (!isAiEnabled()) {
    throw new AiDisabledError();
  }
}
