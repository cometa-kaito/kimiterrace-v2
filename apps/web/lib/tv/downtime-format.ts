/**
 * F16 §5 (ADR-023): TV ダウンタイム履歴 / 稼働サマリ表示の **純粋フォーマッタ**（サーバ側・副作用なし）。
 *
 * 履歴・サマリの表示は **色のみに依存しない**（NFR05 / WCAG 2.2 AA）。継続秒数・原因・継続中フラグは
 * すべてテキストで表す。`now` は引数で受け内部時計を持たない（テストで決定的に検証できる）。
 *
 * PII を入れない（device_id / 教室ラベルの生値はここで扱わない、ルール4）。
 */

import type { DowntimeCauseCategory } from "./downtime-cause";

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

// ---------------------------------------------------------------------------
// 推定原因カテゴリの表示（運営整理 Phase6 / BUG-2 切り分け加速）
// downtime-cause.ts の estimateDowntimeCause が返すカテゴリの日本語ラベル・根拠文・候補を一元管理する。
// DB の cause_hint enum（上記 TV_DOWNTIME_CAUSE_LABEL）とは別系統（表示・診断専用、ルール3 の値域は混同しない）。
// ---------------------------------------------------------------------------

/**
 * 推定原因カテゴリの表示ラベル。`Record<DowntimeCauseCategory, string>` への代入でカテゴリ全値の網羅を
 * コンパイル時に強制する（カテゴリが増えるとここがエラーになり気付ける、ルール3 と同じ網羅性ガード）。
 * 色のみに依存しないテキスト（NFR05 / WCAG 2.2 AA）。
 */
export const DOWNTIME_CAUSE_CATEGORY_LABEL: Record<DowntimeCauseCategory, string> = {
  reboot: "再起動・電源復帰の可能性",
  network: "通信断",
  scheduled_off: "消灯時間帯（正常の可能性）",
  indeterminate: "応答途絶（未確定）",
  ongoing_action: "未復帰・要対応",
  ongoing_watch: "未復帰・様子見（消灯中）",
};

/**
 * 推定の **根拠（透明性）**。なぜこの推定なのかを運営者に 1 行で示す。schedule 由来は「現在設定基準」と
 * 明示し、過去の設定変更でズレうる soft context であることを伝える（downtime-cause.ts の 2 層トラスト参照）。
 */
export const DOWNTIME_CAUSE_CATEGORY_RATIONALE: Record<DowntimeCauseCategory, string> = {
  reboot: "復帰時に端末の再起動を観測（last_boot_at 進行）。",
  network: "復帰時に通信断として記録（cause_hint=network）。",
  scheduled_off:
    "発生時刻が現在の消灯スケジュール窓内のため、正常な黒画面の可能性（現在設定基準・過去設定とは異なる場合あり）。",
  indeterminate:
    "ポーリング途絶のみ観測。電源OFF / ネット断 / アプリ停止は区別できません（ADR-023）。",
  ongoing_action: "未復帰、かつ現在は表示時間帯。応答が戻っていないため要対応。",
  ongoing_watch: "未復帰、ただし現在は消灯時間帯のため、まずは様子見。",
};

/**
 * `indeterminate`（応答途絶・未確定）のときに併記する候補。断定せず 3 つを正直に並べる
 * （ADR-023 §悪い影響: 心拍だけでは区別不能）。
 */
export const DOWNTIME_CAUSE_INDETERMINATE_CANDIDATES: readonly string[] = [
  "電源OFF",
  "ネットワーク断",
  "アプリ停止",
];

/** 推定原因カテゴリの表示用記述（ラベル・根拠・候補）をまとめて返す。候補は indeterminate のときのみ。 */
export function describeDowntimeCause(category: DowntimeCauseCategory): {
  label: string;
  rationale: string;
  candidates: readonly string[];
} {
  return {
    label: DOWNTIME_CAUSE_CATEGORY_LABEL[category],
    rationale: DOWNTIME_CAUSE_CATEGORY_RATIONALE[category],
    candidates: category === "indeterminate" ? DOWNTIME_CAUSE_INDETERMINATE_CANDIDATES : [],
  };
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
