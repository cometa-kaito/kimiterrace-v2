import { createHash, timingSafeEqual } from "node:crypto";

/**
 * F13 (#408, ADR-020 §5): SwitchBot Webhook の共有シークレット検証。
 *
 * SwitchBot は HMAC 署名を強制しないため、ADR-020 は HMAC ではなく **共有シークレット**方式を採用。
 * シークレットは Secret Manager（本番）/ env（ローカル・テスト）から読む（CLAUDE.md ルール5、
 * コード直書き禁止）。提供値との比較は **定数時間**で行い、タイミング攻撃でシークレットを推測されない。
 */

/** 設定済みシークレットを env から取得。未設定なら null（= 受信を全拒否、fail-closed）。 */
export function getConfiguredWebhookSecret(): string | null {
  const s = process.env.SWITCHBOT_WEBHOOK_SECRET;
  return typeof s === "string" && s.length > 0 ? s : null;
}

/**
 * 提供されたキーが設定値と一致するか定数時間で検証する。
 *
 * 長さの違いを早期 return でリークしないよう、双方を SHA-256 で固定長（32 byte）に潰してから
 * `timingSafeEqual` で比較する。これにより長さ・内容ともにタイミング差を生まない。
 */
export function verifyWebhookSecret(
  provided: string | null | undefined,
  expected: string,
): boolean {
  if (typeof provided !== "string" || provided.length === 0) return false;
  const digest = (v: string): Buffer => createHash("sha256").update(v, "utf8").digest();
  return timingSafeEqual(digest(provided), digest(expected));
}
