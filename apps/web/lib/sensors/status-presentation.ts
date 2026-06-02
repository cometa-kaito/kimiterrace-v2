import type { SensorHealthStatus } from "@kimiterrace/db";

/**
 * F13 (#391, ADR-020): センサー稼働ヘルス状態の **表示用プレゼンテーション**（純粋関数）。
 *
 * 状態の判定ロジック自体はサーバ側（`@kimiterrace/db` の `listSensorDeviceStatuses`、DB の now()
 * 基準）に集約済み。本モジュールはその結果（`SensorHealthStatus`）を **UI 表示要素へ写像する**
 * だけの純関数群で、副作用も DB/cookie 依存も持たない（node 環境の unit テストで網羅検証する）。
 *
 * ## NFR05（WCAG 2.2 AA）色だけに依存しない
 * 各状態は **テキストラベル**（`label`）を必ず持ち、色（`color`/`background`）は補助に留める。
 * 記号（`symbol`）も併記するが、記号単独・色単独で意味を伝えない。
 *
 * ## device_mac マスク（F13 §4）
 * device_mac は擬似識別子。一覧 UI では **末尾 4 hex 桁のみ平文**で示し、それ以外は伏せる。
 * フル値は将来の system_admin 詳細画面のみ（本スライス＝一覧では出さない）。
 */

/** 状態 1 つ分の表示メタ。色は補助で、label/symbol が一次情報（NFR05）。 */
export type SensorStatusPresentation = {
  /** 画面に出す日本語ラベル（色に依存せず状態を伝える一次情報）。 */
  label: string;
  /** 補助記号（絵文字。スクリーンリーダ向けには label を併記する前提）。 */
  symbol: string;
  /** 文字色（補助）。 */
  color: string;
  /** 背景色（補助）。 */
  background: string;
};

const PRESENTATION: Record<SensorHealthStatus, SensorStatusPresentation> = {
  healthy: { label: "稼働中", symbol: "🟢", color: "#166534", background: "#dcfce7" },
  quiet: { label: "静観", symbol: "🟡", color: "#854d0e", background: "#fef9c3" },
  dead: { label: "応答なし", symbol: "🔴", color: "#991b1b", background: "#fee2e2" },
  never: { label: "未検知", symbol: "⚪", color: "#374151", background: "#f3f4f6" },
};

/** ヘルス状態 → 表示メタ。未知値が来ても never 相当に倒す（防御的、UI を壊さない）。 */
export function presentSensorStatus(status: SensorHealthStatus): SensorStatusPresentation {
  return PRESENTATION[status] ?? PRESENTATION.never;
}

/**
 * device_mac を一覧表示用にマスクする（F13 §4: 末尾 4 hex 桁のみ平文）。
 *
 * 入力の表記ゆれ（コロン/ハイフン区切り、大小文字）を吸収して英数字だけを取り出し、
 * 末尾 4 文字を残して前方を `…` で伏せる。4 文字以下しか無い異常入力はそのまま返す。
 */
export function maskDeviceMac(deviceMac: string): string {
  const hex = deviceMac.replace(/[^0-9A-Za-z]/g, "");
  if (hex.length <= 4) return hex || deviceMac;
  const tail = hex.slice(-4).toUpperCase();
  // 末尾 2 桁ずつをコロン区切りで添える（SwitchBot 開発画面表記に寄せた可読性）。
  return `…${tail.slice(0, 2)}:${tail.slice(2)}`;
}
