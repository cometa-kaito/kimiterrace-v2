/**
 * F16 §5 (ADR-023): TV ダウンタイム履歴 / 稼働サマリ表示の **純粋フォーマッタ**（サーバ側・副作用なし）。
 *
 * 履歴・サマリの表示は **色のみに依存しない**（NFR05 / WCAG 2.2 AA）。継続秒数・原因・継続中フラグは
 * すべてテキストで表す。`now` は引数で受け内部時計を持たない（テストで決定的に検証できる）。
 *
 * PII を入れない（device_id / 教室ラベルの生値はここで扱わない、ルール4）。
 */

/** ダウンタイム原因（`tv_device_downtime.cause_hint`）の表示ラベル。NULL = 未判定。 */
export const TV_DOWNTIME_CAUSE_LABEL: Record<"unknown" | "reboot" | "network", string> = {
  unknown: "原因不明",
  reboot: "再起動",
  network: "通信断",
};

/**
 * cause_hint（enum 値 or null）を日本語ラベルにする。null / 未知値は「未判定」に倒す
 * （色のみに依存しないテキスト表示、NFR05）。
 */
export function formatDowntimeCause(cause: string | null): string {
  if (cause === null) return "未判定";
  return TV_DOWNTIME_CAUSE_LABEL[cause as keyof typeof TV_DOWNTIME_CAUSE_LABEL] ?? "未判定";
}

/**
 * ダウン継続秒数を人間可読な日本語に整形する（例: `90` → "1分30秒"、`3700` → "1時間1分40秒"）。
 *
 * - `null`（継続中 = まだ復帰観測されていない）は "継続中" を返す（UI は「現在進行中のアウテージ」と分かる）。
 * - 0 秒は "0秒"（瞬断で復帰直後に締まった場合も明示）。
 * - 負値は防御的に 0 として扱う（DB 側で GREATEST(0,...) 済みだが二重で安全側）。
 * - 時/分/秒のうち 0 の単位は省く（"1時間" / "30秒" 等）。ただし全単位 0 のときだけ "0秒"。
 */
export function formatDowntimeDuration(durationSec: number | null): string {
  if (durationSec === null) return "継続中";
  const total = Math.max(0, Math.floor(durationSec));
  if (total === 0) return "0秒";

  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}時間`);
  if (minutes > 0) parts.push(`${minutes}分`);
  if (seconds > 0) parts.push(`${seconds}秒`);
  return parts.join("");
}

/**
 * timestamptz（Date）を JST の "M/D HH:mm" で表示する。null は em-dash（"—"、復帰前の recovered_at 等）。
 * tv-devices 一覧の `formatLastSeen` と同じ書式・タイムゾーン（JST）に揃える。
 */
export function formatJstTimestamp(value: Date | null): string {
  if (value === null) return "—";
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}
