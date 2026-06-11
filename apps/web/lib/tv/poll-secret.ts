import { createHash, timingSafeEqual } from "node:crypto";

/**
 * F15 (ADR-022 §認証): TV ポーリング `GET /api/tv/config?device_id=...&key=...` の共有シークレット検証。
 *
 * ADR-022 は初期フェーズで **共通シークレット**方式を採る（Phase 2 で TV 個別の `tv_device_tokens` に
 * 移行、F15 §5。本基盤スライスではトークンテーブルは未実装）。シークレットは Secret Manager（本番）/
 * env（ローカル・テスト）から読む（CLAUDE.md ルール5、コード直書き禁止）。提供値との比較は **定数時間**
 * で行い、タイミング攻撃でシークレットを推測されないようにする（sensors/webhook-secret.ts と同方式）。
 *
 * ## ゼロダウンタイム鍵ローテーション（kimiteras-lp lib/auth.ts と同方式）
 * 現用キー `TV_POLL_SECRET`（＝新キー）に加え、移行期間中だけ旧キー `TV_POLL_SECRET_LEGACY` も受理する。
 * 全機器（TV 端末）を新キーへ更新し終えたら `TV_POLL_SECRET_LEGACY` を外して再デプロイすれば旧キーは無効化。
 * `TV_POLL_SECRET_LEGACY` 未設定時は「`TV_POLL_SECRET` のみ受理」となり従来挙動と完全に同一。
 */

/** 設定済みシークレット（現用）を env から取得。未設定なら null（= 設定不備、fail-closed）。 */
export function getConfiguredTvPollSecret(): string | null {
  const s = process.env.TV_POLL_SECRET;
  return typeof s === "string" && s.length > 0 ? s : null;
}

/** 移行期のみ受理する旧シークレットを env から取得。未設定なら null（単一キー運用）。 */
export function getLegacyTvPollSecret(): string | null {
  const s = process.env.TV_POLL_SECRET_LEGACY;
  return typeof s === "string" && s.length > 0 ? s : null;
}

/** 受理対象キー一覧（現用 + 移行期の旧）。いずれも未設定なら空（= fail-closed）。 */
function configuredTvPollKeys(): string[] {
  return [getConfiguredTvPollSecret(), getLegacyTvPollSecret()].filter(
    (k): k is string => k !== null,
  );
}

/**
 * 提供されたキーが設定値と一致するか定数時間で検証する（単一キー・純関数）。
 *
 * 長さの違いを早期 return でリークしないよう、双方を SHA-256 で固定長（32 byte）に潰してから
 * `timingSafeEqual` で比較する（長さ・内容ともにタイミング差を生まない）。
 */
export function verifyTvPollSecret(provided: string | null | undefined, expected: string): boolean {
  if (typeof provided !== "string" || provided.length === 0) return false;
  const digest = (v: string): Buffer => createHash("sha256").update(v, "utf8").digest();
  return timingSafeEqual(digest(provided), digest(expected));
}

/**
 * 提供キーが受理キー（現用 `TV_POLL_SECRET` / 移行期 `TV_POLL_SECRET_LEGACY`）のいずれかに一致するか。
 *
 * ゼロダウンタイム鍵ローテーション用。一致したキーの位置でタイミング差を出さないよう、
 * **全候補を必ず評価**してから結果を返す（早期 return しない）。受理キーが 1 つも未設定なら
 * fail-closed で false。各候補比較は `verifyTvPollSecret` の定数時間比較を用いる。
 */
export function verifyTvPollKey(provided: string | null | undefined): boolean {
  if (typeof provided !== "string" || provided.length === 0) return false;
  const keys = configuredTvPollKeys();
  if (keys.length === 0) return false;
  let ok = false;
  for (const expected of keys) {
    if (verifyTvPollSecret(provided, expected)) ok = true;
  }
  return ok;
}
