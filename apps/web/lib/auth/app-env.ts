/**
 * 実行環境（staging / prod / dev / local）の判定。**サーバー専用**（process.env を読む）。
 *
 * ## 背景（staging 限定 dev-login のための多層防御。CLAUDE.md ルール5 / セキュリティ最優先の心構え）
 *
 * staging（実データ無し）では運用者 / エージェントが**パスワードを打たずに**教員 / 学校管理者の
 * セッションを得たい（dev-login）。これは便利だが、本番（公立校の実データ）に同経路が生きていれば致命的な
 * 認証バイパスになる。そこで **二重のゲート**で「prod では原理的に機能しない」ことを保証する:
 *
 * 1. **env ゲート（fail-closed・本モジュール）**: `isStagingEnv()` が `APP_ENV === "staging"` の時だけ true。
 *    `APP_ENV` 未設定 / 想定外の値はすべて **false（= dev-login route は 404）**。prod の Cloud Run には
 *    `APP_ENV=staging` を**配線しない**（terraform envs/staging のみで設定し、envs/prod には足さない）ため、
 *    prod では未設定 → 常に 404。
 * 2. **秘密キーゲート（dev-login-config.ts）**: `DEV_LOGIN_CONFIG`（Secret Manager・staging のコンテナのみ）の
 *    `secret` と提供キーを定数時間突合する。config 未注入なら鍵検証は不能（false）。
 *
 * → prod は **(1) APP_ENV 不在で 404**、かつ **(2) DEV_LOGIN_CONFIG 不在で鍵検証も不能**。どちらか一方が
 *    破られても他方が残る（多層防御）。両方を prod に入れない限り dev-login は機能しない。
 */

/** 実行環境が staging か。`APP_ENV === "staging"` のみ true（未設定 / 想定外は false = fail-closed）。 */
export function isStagingEnv(): boolean {
  return process.env.APP_ENV === "staging";
}
