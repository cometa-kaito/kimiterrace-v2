import { createHash, timingSafeEqual } from "node:crypto";

/**
 * C方式 TV プロビジョニング エージェント API (`POST /api/tv/provisioning/claim` /
 * `POST /api/tv/provisioning/[jobId]/status`) の共有シークレット検証。
 *
 * 学校 LAN 上のローカル provision-agent (PR5) が adb 経由で実機 TV をセットアップするため、サーバの
 * claim/status エンドポイントを数秒間隔でポーリングする。その認証は **TV ポーリング (TV_POLL_SECRET)
 * とは別の専用シークレット** `PROVISION_AGENT_SECRET` で行う（最小権限の分離: TV 配信鍵が漏れても
 * エージェント API は影響を受けず、逆も同様）。`poll-secret.ts` と同じく Secret Manager（本番）/
 * env（ローカル・テスト）から読み（CLAUDE.md ルール5、コード直書き禁止）、比較は **定数時間**で行う
 * （タイミング攻撃でシークレットを推測されない）。本番 secret コンテナ / Cloud Run env 配線は PR6。
 */

/**
 * 設定済みエージェントシークレットを env から取得。未設定 / 空なら null（= エージェント API を全拒否、
 * fail-closed）。`poll-secret.ts` の `getConfiguredTvPollSecret` と同形。
 */
export function getConfiguredProvisionAgentSecret(): string | null {
  const s = process.env.PROVISION_AGENT_SECRET;
  return typeof s === "string" && s.length > 0 ? s : null;
}

/**
 * 提供されたキーが設定値と一致するか定数時間で検証する。
 *
 * 長さの違いを早期 return でリークしないよう、双方を SHA-256 で固定長（32 byte）に潰してから
 * `timingSafeEqual` で比較する（長さ・内容ともにタイミング差を生まない）。`verifyTvPollSecret` と同方式。
 */
export function verifyProvisionAgentSecret(
  provided: string | null | undefined,
  expected: string,
): boolean {
  if (typeof provided !== "string" || provided.length === 0) return false;
  const digest = (v: string): Buffer => createHash("sha256").update(v, "utf8").digest();
  return timingSafeEqual(digest(provided), digest(expected));
}
