/**
 * F15 §4.1 / F16 §5 (ADR-023): TV の稼働ステータス判定（純関数・サーバ側集約）。
 *
 * 判定ロジックは **サーバ側に集約**し（F15 §4.1 / ADR-023）、UI は色 + テキストの両方で示す（NFR05 /
 * WCAG 2.2 AA、色のみに依存しない）。本基盤スライスは `last_seen_at` の鮮度だけで 3 値に分ける素朴版で、
 * 「直近 1h 検知あり」等の検知件数連動（F15 §4.1）と OFF 時間帯の閾値緩和（F16 §2）は定期チェッカ /
 * ダッシュボード統合の follow-up スライスで重ねる（その時はこの純関数の引数を拡張する）。
 *
 *  - `online`   : last_seen_at が `ONLINE_THRESHOLD_MS`（既定 5 分）以内 → 🟢 正常稼働
 *  - `quiet`    : last_seen_at が `QUIET_THRESHOLD_MS`（既定 1 時間）以内 → 🟡 静穏（OFF 時間帯等で許容）
 *  - `down`     : last_seen_at が 1 時間より前 → 🔴 応答なし（要確認）
 *  - `never`    : last_seen_at が null（一度もポーリングしていない＝登録直後 / 未接続）
 *
 * `now` は引数で受け、内部時計を持たない（テストで決定的に検証できる）。
 */

export type TvLivenessStatus = "online" | "quiet" | "down" | "never";

/** 🟢 online と判定する last_seen ギャップ上限（既定 5 分、F15 §4.1）。 */
export const ONLINE_THRESHOLD_MS = 5 * 60 * 1000;
/** 🟡 quiet と判定する last_seen ギャップ上限（既定 1 時間、F15 §4.1）。これを超えると down。 */
export const QUIET_THRESHOLD_MS = 60 * 60 * 1000;

/**
 * `last_seen_at`（null 可）と現在時刻から稼働ステータスを判定する。
 *
 * @param lastSeenAt 最終ポーリング時刻（DB の timestamptz。null = 未ポーリング）。
 * @param now        判定基準時刻（呼び出し側が `new Date()` を渡す。テストで固定可）。
 */
export function classifyTvLiveness(lastSeenAt: Date | null, now: Date): TvLivenessStatus {
  if (lastSeenAt === null) return "never";
  const gapMs = now.getTime() - lastSeenAt.getTime();
  if (gapMs <= ONLINE_THRESHOLD_MS) return "online";
  if (gapMs <= QUIET_THRESHOLD_MS) return "quiet";
  return "down";
}

/** ステータスの表示ラベル（色のみに依存しないテキスト、NFR05）。絵文字は色の補助で本体はテキスト。 */
export const TV_STATUS_LABEL: Record<TvLivenessStatus, string> = {
  online: "稼働中",
  quiet: "静穏",
  down: "応答なし",
  never: "未接続",
};

/** ステータスのアイコン（色の補助。読み上げ時はラベルが本体）。 */
export const TV_STATUS_ICON: Record<TvLivenessStatus, string> = {
  online: "🟢",
  quiet: "🟡",
  down: "🔴",
  never: "⚪",
};

/**
 * device_id を一覧表示用に短縮する（先頭 8 桁等。F16 §4 のアラートマスクと同方針で UI でも生 device_id を
 * 全長露出しない）。空文字 / 短い値はそのまま返す。
 */
export function shortDeviceId(deviceId: string): string {
  return deviceId.length > 8 ? `${deviceId.slice(0, 8)}…` : deviceId;
}

/**
 * MAC アドレスを末尾 4 文字のみ平文表示にマスクする（F15 §5: UI 上は末尾 4 文字のみ、フル値は
 * system_admin 詳細画面のみ）。null / 4 文字以下はラベルに倒す。
 */
export function maskMac(mac: string | null): string {
  if (!mac) return "—";
  // 区切り（: / -）を除いた末尾 4 文字を採る（"DC:A5:..:98:A1" → "98A1"。区切りが末尾 4 に
  // 混ざって部分的な hex が漏れるのを防ぐ）。正規化後が 4 文字以下ならそのまま返す。
  const hex = mac.replace(/[:-]/g, "");
  if (hex.length <= 4) return hex;
  return `****${hex.slice(-4)}`;
}
