import { FixedWindowRateLimiter } from "../guide/rate-limit";

/**
 * F07 サイネージ行動ログ取込 `POST /signage/{classToken}/events` の濫用対策 (#43)。
 *
 * 非認証の公開エンドポイントなので、有効トークンを握った端末/攻撃者が大量 INSERT で `events` を
 * 汚染しうる。guide フィードバック (#234) と同じ固定ウィンドウ制限を application 層に置くが、
 * **key は IP ではなく classToken のハッシュ**にする:
 * - サイネージ端末は学校 LAN の共有 NAT 越しになりやすく、per-IP だと同一校の複数端末が 1 バケットを
 *   奪い合う。表示単位 (classToken) ごとに上限を張る方が自然で、正規の 1 端末のバッチ送信を阻害しない。
 * - raw token は credential なので key にせずハッシュを使う ([[]] ルール5、ログにも残さない)。
 *
 * per-instance / 分散の限界は guide と同じ ({@link FixedWindowRateLimiter} docstring、#155 共有ストア)。
 * ハードな保証は infra 層 (Cloud Armor) が担う defense-in-depth。
 *
 * 既定: 1 classToken あたり 60 秒で 30 リクエスト。端末が数十秒間隔でバッチ送信する正常系には十分な
 * 余裕で、毎秒ループのような flood は確実に頭打ちになる (1 リクエスト = 最大 MAX_EVENTS_PER_BATCH 件)。
 */
export const SIGNAGE_EVENTS_LIMIT = 30;
export const SIGNAGE_EVENTS_WINDOW_MS = 60 * 1000;

export const signageEventsRateLimiter = new FixedWindowRateLimiter(
  SIGNAGE_EVENTS_LIMIT,
  SIGNAGE_EVENTS_WINDOW_MS,
);
