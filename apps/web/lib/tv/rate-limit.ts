import { FixedWindowRateLimiter } from "../guide/rate-limit";

/**
 * F15 (ADR-022 §レート制限): TV ポーリング `GET /api/tv/config` の濫用保護。
 *
 * ADR-022 は「1 device_id あたり 1 分 5 リクエスト」を規定する（正常運用は 60 秒間隔ゆえ余裕。超過は
 * 誤設定/暴走/攻撃の兆候）。`lib/guide/rate-limit.ts` の `FixedWindowRateLimiter` を流用し、key は
 * device_id にする（IP ではない＝学校 NAT 越しに複数 TV が同一 IP を共有しても device 単位で独立に
 * 数える）。Cloud Run インスタンス単位・per-instance の第一防壁で、強い保証は WAF / Cloud Armor 併用。
 *
 * 未登録 device_id の総当たり（解決前のレート）も device_id 単位で頭打ちになるが、device_id が無い
 * リクエストは下流で 400 に倒す（route 側）。
 */
export const TV_POLL_LIMIT = 5;
export const TV_POLL_WINDOW_MS = 60 * 1000;

export const tvPollRateLimiter = new FixedWindowRateLimiter(TV_POLL_LIMIT, TV_POLL_WINDOW_MS);

/**
 * C方式 TV プロビジョニング エージェント API (`POST /api/tv/provisioning/claim` /
 * `.../[jobId]/status`、PR4) の濫用保護。
 *
 * ローカル provision-agent (PR5) は実機セットアップ中、claim → 各ステップ status を **数秒間隔**で叩く
 * ため TV ポーリング (60 秒間隔 / 5 req) より高頻度。1 分 30 req を上限にすると、正常な claim + 段階報告
 * （preflight / install / device_owner / prefs / launch 等を細かく報告しても）は余裕で収まる一方、鍵漏洩時
 * の総当たり / 暴走ループは頭打ちになる。key は `clientKeyFromHeaders`（XFF 左端 = client IP）にする
 * （TV のような device_id を持たないため）。per-instance の第一防壁で、強い保証は WAF / Cloud Armor 併用
 * （`lib/guide/rate-limit.ts` docstring の限界どおり）。
 */
export const PROVISION_AGENT_LIMIT = 30;
export const PROVISION_AGENT_WINDOW_MS = 60 * 1000;

export const provisionAgentRateLimiter = new FixedWindowRateLimiter(
  PROVISION_AGENT_LIMIT,
  PROVISION_AGENT_WINDOW_MS,
);
