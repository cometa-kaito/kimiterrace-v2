import { FixedWindowRateLimiter } from "@/lib/guide/rate-limit";

/**
 * M-2 (#464): F07 サイネージ行動イベント取り込み `POST /signage/{classToken}/events` の濫用対策。
 *
 * `classToken` は教室掲示の URL/QR に載り base64url で可読、失効まで最長 90 日 rotate なし。これを得た
 * 者が `{"type":"view"}` を loop POST すると 1 リクエストにつき SECURITY DEFINER 解決 + RLS tx +
 * `INSERT events` が走り、特定校の `events` 肥大・F08 ダッシュボード / 広告到達数の歪曲を招く
 * (越境漏洩ではないが導入前に潰す defense-in-depth gap、#243 検証由来)。
 *
 * **per-IP ではなく per-`classToken`**: events は実機 (50 台/校, ADR-025) が高頻度に発火し校内は NAT で
 * 同一 IP に集まるため、IP 単位の制限は正規の行動ログを誤って落とす ({@link recordSignageEvent} の
 * route docstring 参照)。よって濫用主体が token 保持者に限定される性質を活かし、**token hash をキー**に
 * した固定ウィンドウ制限を置く。キーは平文トークンでなく hash なので credential を Map に残さない
 * (ルール5)。
 *
 * **限界 (正直に明記)**: {@link FixedWindowRateLimiter} と同じく per-instance (module-level Map) で、
 * 複数 Cloud Run インスタンス構成では token 単位の全体上限を跨インスタンスで保証しない。volumetric な
 * hard guarantee は infra 層 WAF (Cloud Armor, ルール8) が担う。本 limiter は単一 token flood への
 * 第一防壁であり、それ単体の砦ではない。
 */

/**
 * 既定上限: 1 token あたり 60 秒で 600 件 (= 10 req/s 持続)。
 *
 * 正規トラフィックは 1 掲示につき表示ローテーション由来の view + 散発的な tap で、複数端末が同一 token を
 * 共有しても分次で数十〜百件程度に収まる (ADR-025 のハートビート規模を十分上回るマージン)。一方で
 * 毎リクエスト loop の flood は確実に頭打ちになる。チューニング容易なよう定数に切り出す。
 */
export const SIGNAGE_EVENT_LIMIT = 600;
export const SIGNAGE_EVENT_WINDOW_MS = 60 * 1000;

/**
 * 429 応答の `Retry-After` ヘッダ秒数。窓幅から導出し、ハードコード literal が
 * {@link SIGNAGE_EVENT_WINDOW_MS} とドリフトするのを防ぐ (#469 Reviewer Nit)。
 */
export const SIGNAGE_EVENT_RETRY_AFTER_SECONDS = Math.ceil(SIGNAGE_EVENT_WINDOW_MS / 1000);

/**
 * signage events 用の module-level シングルトン。module スコープに置くことで Cloud Run の同一
 * インスタンス内の複数リクエストで状態を共有する (per-instance、上記の限界どおり)。
 */
export const signageEventRateLimiter = new FixedWindowRateLimiter(
  SIGNAGE_EVENT_LIMIT,
  SIGNAGE_EVENT_WINDOW_MS,
);
