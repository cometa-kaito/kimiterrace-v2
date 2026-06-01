import { FixedWindowRateLimiter } from "../guide/rate-limit";

/**
 * F07 (#464, #243 検証由来): サイネージ行動イベント取り込み `POST /signage/{classToken}/events` の
 * app 層 defense-in-depth レート制限。
 *
 * **なぜ per-token (per-IP ではない)**: events ルートは意図的に IP 単位の制限を採らない。実機 (50 台/校,
 * ADR-025) が高頻度に発火し校内は NAT で同一 IP に集まるため、IP 制限は**正規の行動ログを誤って落とし
 * F07 のデータを欠損させる** (route.ts の設計注記)。一方、上限が body-size (2KB) と platform cap だけだと、
 * 有効 `classToken` (教室掲示の URL/QR に base64url で可読・最長 90 日 rotate なし) の保持者が
 * `{"type":"view"}` を loop POST して特定校の `events` を肥大化させ、F08 ダッシュボード/広告到達数を
 * 歪曲できる。そこで **per-`classToken` の固定ウィンドウ制限**を置く。token をキーにするので NAT 懸念を
 * 回避しつつ、単一 token からの flood だけを頭打ちにできる。
 *
 * **キーは token ハッシュ**: 平文 `classToken` は credential (ルール5) なので、`hashToken` した値を
 * limiter のキーにする。limiter の状態は per-instance の in-memory Map に閉じるが、平文を Map キーに
 * 載せない。
 *
 * **上限のチューニング**: 正規トラフィック (1 教室の表示端末が広告ローテーション毎に view、稀に tap)
 * を十分上回る寛容な値にする。1 分窓 600 件 = 10 req/s/token は単一教室の実トラフィックの数十倍であり
 * 正規ログを落とさない一方、毎秒 POST するループは確実に頭打ちになる。値はチューニング容易なよう定数化。
 *
 * **限界 (正直に明記)**: per-instance のみ (Cloud Run の 1 インスタンス内、guide/rate-limit.ts と同型) で、
 * 複数インスタンスを跨ぐグローバル上限は保証しない。**volumetric な hard guarantee は依然 infra 層 WAF
 * (Cloud Armor, ルール8) が担う** — 本 limiter は WAF が land するまでの安全網であり、それ単体の砦では
 * ない。アルゴリズム実体 (固定ウィンドウ + メモリ境界の eviction) は `FixedWindowRateLimiter` を再利用する。
 */

/** events 1 token あたりの上限: 60 秒窓で 600 件 (= 10 req/s、正規の単一教室トラフィックの数十倍)。 */
export const SIGNAGE_EVENT_LIMIT = 600;
export const SIGNAGE_EVENT_WINDOW_MS = 60 * 1000;

/**
 * events エンドポイント用の module-level シングルトン。module スコープに置くことで Cloud Run の
 * 同一インスタンス内の複数リクエストで token 単位の窓を共有する (per-instance、上記の限界どおり)。
 */
export const signageEventRateLimiter = new FixedWindowRateLimiter(
  SIGNAGE_EVENT_LIMIT,
  SIGNAGE_EVENT_WINDOW_MS,
);
