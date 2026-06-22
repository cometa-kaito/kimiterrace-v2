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

/**
 * 実行環境が **本番（prod）と判定され得る**か。prod を積極的に示す痕跡があれば true（無ければ false）。
 *
 * ## なぜ「staging でない」とは別に prod 専用の hard-block を置くか（多層防御の第3層・打消しゲート）
 * dev-login の prod 無効化は本来 (1) `APP_ENV==='staging'` ゲート + (2) `DEV_LOGIN_CONFIG` 不在で十分。だが
 * 「prod に staging 用 env（`APP_ENV=staging` や config）が誤って混入した」最悪ケースを想定し、**prod の痕跡が
 * 一つでもあれば他のゲートの結果に関わらず無条件で拒否**する打消しゲートを足す（fail-closed の保険）。
 * `isStagingEnv()` が「許可する数少ない条件」を AND で絞るのに対し、こちらは「絶対に許可してはならない条件」を
 * 独立に OR で弾く。route では `isProdLikeEnv()` を **最優先で評価**し、true なら即 404。
 *
 * ## 判定信号（staging を巻き込まないものだけ）
 * - `APP_ENV` が `prod` / `production`。
 * - GCP プロジェクト ID（`GOOGLE_CLOUD_PROJECT` / `GCP_PROJECT` / `GCLOUD_PROJECT`）に `prod` の痕跡。
 *   prod と staging は別プロジェクトなので、prod のプロジェクト名に `prod` が含まれる場合に効く（無ければ無害）。
 *
 * **注意**: `NODE_ENV === "production"` は staging でも true（Dockerfile が全デプロイ環境で設定）なので prod の
 * 判定には**使わない**（使うと staging まで巻き込んで dev-login が常に死ぬ）。
 */
export function isProdLikeEnv(): boolean {
  const appEnv = process.env.APP_ENV;
  if (appEnv === "prod" || appEnv === "production") return true;
  const project =
    process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCP_PROJECT ?? process.env.GCLOUD_PROJECT;
  if (typeof project === "string" && /prod/i.test(project)) return true;
  return false;
}
