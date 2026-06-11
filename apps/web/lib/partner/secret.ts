import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Partner API（portal ↔ v2 サーバー間）の共有シークレット検証。
 * 契約: `docs/api/partner-api-contract.md` §1。
 *
 * `lib/tv/poll-secret.ts` と**同方式**（SHA-256 で固定長に潰してから `timingSafeEqual` で定数時間比較）。
 * シークレットは Secret Manager（本番）/ env（ローカル・テスト）から読む（CLAUDE.md ルール5、コード直書き禁止）。
 * 未設定なら全拒否（fail-closed）。本 lib は **pure**（next/server に依存しない）。401 応答は呼出側の Route Handler が返す。
 */

/** 設定済みシークレットを env から取得。未設定なら null（= Partner API を全拒否、fail-closed）。 */
export function getConfiguredPartnerSecret(): string | null {
  const s = process.env.PARTNER_API_SECRET;
  return typeof s === "string" && s.length > 0 ? s : null;
}

/**
 * 提供キーが設定値と一致するか定数時間で検証する。
 * 長さの違いを早期 return でリークしないよう、双方を SHA-256（32 byte 固定長）に潰してから比較する。
 */
export function verifyPartnerSecret(
  provided: string | null | undefined,
  expected: string,
): boolean {
  if (typeof provided !== "string" || provided.length === 0) return false;
  const digest = (v: string): Buffer => createHash("sha256").update(v, "utf8").digest();
  return timingSafeEqual(digest(provided), digest(expected));
}

/**
 * Request ヘッダから partner key を取り出す。
 * `x-partner-key` を優先し、無ければ `Authorization: Bearer <key>` を許容（契約 §1）。
 */
export function partnerKeyFromHeaders(headers: Headers): string | null {
  const direct = headers.get("x-partner-key");
  if (typeof direct === "string" && direct.length > 0) return direct;
  const auth = headers.get("authorization");
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice("Bearer ".length).trim();
    return token.length > 0 ? token : null;
  }
  return null;
}
