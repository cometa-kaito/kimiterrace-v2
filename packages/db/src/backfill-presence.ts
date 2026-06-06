import { canonicalizeMac } from "./seed-ginan-sensors.js";

/**
 * F13 (#391, ADR-020): PoC 本番（LP / Turso `motion_events`）の来場検知履歴を v2 `events`(type='presence')
 * へ取り込むための **純パース/正規化ロジック（副作用なし）**。実投入は backfill-presence-cli.ts。
 *
 * 入力は NDJSON（1 行 1 イベント）: `{"mac":"DC:A5:B3:C2:98:D7","state":"DETECTED","ms":1748...}`。
 * mac は webhook ingest と同じ正規形（大文字・区切り無し）に畳んでから解決/保存する
 * （`recordPresenceEvent` / `sensor-presence.ts` と一致）。PII 非格納（device/検知メタ + 時刻のみ）。
 */

export interface BackfillPresenceRow {
  /** 正規化済み device MAC（大文字・区切り無し）。sensor_devices 解決キー。 */
  deviceMac: string;
  /** 検知状態（大文字化）。"DETECTED" / "NOT_DETECTED" 等。 */
  detectionState: string;
  /** 検知時刻（epoch ms）。occurred_at = to_timestamp(ms/1000) に使う。dedup キーの一部。 */
  occurredAtMs: number;
}

/** NDJSON 1 行をパース・正規化する。空行・不正行は null（呼び出し側で除外）。 */
export function parseBackfillLine(line: string): BackfillPresenceRow | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.mac !== "string" || typeof o.state !== "string" || typeof o.ms !== "number") {
    return null;
  }
  if (!Number.isFinite(o.ms) || o.ms <= 0) return null;
  const deviceMac = canonicalizeMac(o.mac);
  if (deviceMac.length === 0) return null;
  return { deviceMac, detectionState: o.state.toUpperCase(), occurredAtMs: o.ms };
}

/** NDJSON テキスト全体をパースし、有効行のみの配列にする。 */
export function parseBackfillNdjson(text: string): BackfillPresenceRow[] {
  return text
    .split(/\r?\n/)
    .map(parseBackfillLine)
    .filter((r): r is BackfillPresenceRow => r !== null);
}
