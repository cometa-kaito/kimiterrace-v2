import { FixedWindowRateLimiter } from "../guide/rate-limit";

/**
 * F13 (#408, ADR-020 §5): SwitchBot Webhook の濫用保護（基本のレート制限）。
 *
 * 公開エンドポイントゆえ、シークレット総当たり等を弱めるため IP 単位の固定窓レート制限を入れる。
 * `lib/guide/rate-limit.ts` の `FixedWindowRateLimiter` を流用（Cloud Run インスタンス単位・IP は
 * XFF 由来で偽装可＝多層防御の 1 枚。強い保証は Cloud Armor 等の WAF と併用、重い hardening は follow-up）。
 *
 * センサーは周期送信のため上限はやや広め（既定: 60 秒窓で 240 件/IP）。
 */
export const SENSOR_WEBHOOK_LIMIT = 240;
export const SENSOR_WEBHOOK_WINDOW_MS = 60 * 1000;

export const sensorWebhookRateLimiter = new FixedWindowRateLimiter(
  SENSOR_WEBHOOK_LIMIT,
  SENSOR_WEBHOOK_WINDOW_MS,
);
