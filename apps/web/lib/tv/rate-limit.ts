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
