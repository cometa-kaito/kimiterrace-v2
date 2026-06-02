import { createHash, timingSafeEqual } from "node:crypto";

/**
 * F15 (ADR-022 §認証): TV ポーリング `GET /api/tv/config?device_id=...&key=...` の共有シークレット検証。
 *
 * ADR-022 は初期フェーズで **共通シークレット**方式を採る（Phase 2 で TV 個別の `tv_device_tokens` に
 * 移行、F15 §5。本基盤スライスではトークンテーブルは未実装）。シークレットは Secret Manager（本番）/
 * env（ローカル・テスト）から読む（CLAUDE.md ルール5、コード直書き禁止）。提供値との比較は **定数時間**
 * で行い、タイミング攻撃でシークレットを推測されないようにする（sensors/webhook-secret.ts と同方式）。
 */

/** 設定済みシークレットを env から取得。未設定なら null（= ポーリングを全拒否、fail-closed）。 */
export function getConfiguredTvPollSecret(): string | null {
  const s = process.env.TV_POLL_SECRET;
  return typeof s === "string" && s.length > 0 ? s : null;
}

/**
 * 提供されたキーが設定値と一致するか定数時間で検証する。
 *
 * 長さの違いを早期 return でリークしないよう、双方を SHA-256 で固定長（32 byte）に潰してから
 * `timingSafeEqual` で比較する（長さ・内容ともにタイミング差を生まない）。
 */
export function verifyTvPollSecret(provided: string | null | undefined, expected: string): boolean {
  if (typeof provided !== "string" || provided.length === 0) return false;
  const digest = (v: string): Buffer => createHash("sha256").update(v, "utf8").digest();
  return timingSafeEqual(digest(provided), digest(expected));
}
