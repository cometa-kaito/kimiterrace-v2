import { createHash, randomBytes } from "node:crypto";

/**
 * F05: magic link トークンの生成とハッシュ化。**サーバー専用** (node:crypto)。
 *
 * 設計 (CLAUDE.md ルール5):
 * - **平文トークンは DB に保存しない**。生成直後に発行レスポンスで教員へ 1 度だけ返し、
 *   DB には SHA-256 ハッシュ (`token_hash`) のみ保存する。漏洩しても DB 側からは復元不能。
 * - トークンは 256bit (32byte) の乱数を base64url 化したもの。URL/QR に安全に載る文字種で、
 *   推測・総当たりが非現実的なエントロピー。`magic_links.token_hash` の lookup は indexed 等価
 *   検索なので、ハッシュ後の照合にタイミング攻撃の余地はない (高エントロピー値の存在判定)。
 * - ハッシュは hex 64 文字。`token_hash varchar(128)` に収まる。
 * - **インフラログの射程 (ルール5)**: 平文トークンは `/s/<token>` の URL パスに載るため、
 *   アプリログに出さなくても **Cloud Run の自動リクエストログ** (`httpRequest.requestUrl`) に
 *   残りうる。この露出は ADR-029 の補償統制 (Cloud Logging 閲覧の最小権限 IAM =
 *   `infrastructure/terraform/modules/logging_iam` + 有効期限/失効/PII なし) 下の Low として受容。
 *   詳細は `docs/compliance/infra-log-secret-exposure.md`。
 *
 * 生成 (`generateToken`) は発行時のみ。検証 (生徒アクセス) 側は受領した平文を `hashToken` で
 * 同じ方式でハッシュ化し、`resolve_magic_link(token_hash)` (packages/db, SECURITY DEFINER) に渡す。
 */

/** トークンの乱数バイト長 (256bit)。 */
const TOKEN_BYTES = 32;

/**
 * 新しい平文トークンを生成する。base64url (`A-Za-z0-9_-`)、約 43 文字。
 * これを URL (`/s/<token>`) / QR に載せる。**ログ・DB に平文で残さないこと**。
 */
export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/**
 * 平文トークンを SHA-256 hex (64 文字) にハッシュ化する。DB に保存・照合するのはこの値のみ。
 * 発行側 (hash して保存) と検証側 (受領 token を hash して resolve) で同一の関数を使うこと。
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
