/**
 * F13: presence 履歴ページ（/app/sensors/[id]/history）の **期間プリセット**の純ロジック。
 *
 * URL の `?range=` クエリ（`1d` / `7d` / `30d` / `90d` / `all`）を、DB クエリ用の `from`/`to`（UTC の
 * Date）と表示ラベルに解決する。Server Component から呼ぶが、決定的に単体テストできるよう `now` を引数で
 * 受け取る純関数にする（実行時は `new Date()` を渡す）。
 *
 * - 既定は `7d`（過去 7 日）。未知の値は既定にフォールバック。
 * - `all` は実質全期間（from = エポック）。`to` は常に「now の少し先」にして当日分を取りこぼさない。
 */

export const PRESENCE_RANGE_KEYS = ["1d", "7d", "30d", "90d", "all"] as const;
export type PresenceRangeKey = (typeof PRESENCE_RANGE_KEYS)[number];

export const DEFAULT_PRESENCE_RANGE: PresenceRangeKey = "7d";

/** 各プリセットの遡る日数（all は null = 全期間）と日本語ラベル。 */
const RANGE_SPEC: Record<PresenceRangeKey, { days: number | null; label: string }> = {
  "1d": { days: 1, label: "過去 24 時間" },
  "7d": { days: 7, label: "過去 7 日間" },
  "30d": { days: 30, label: "過去 30 日間" },
  "90d": { days: 90, label: "過去 90 日間" },
  all: { days: null, label: "全期間" },
};

export type ResolvedPresenceRange = {
  key: PresenceRangeKey;
  label: string;
  /** クエリ範囲の開始（含む）。all はエポック。 */
  from: Date;
  /** クエリ範囲の終了（含まない）。当日分を取りこぼさないよう now + 1 分。 */
  to: Date;
};

/** 未知/未指定を既定にフォールバックして PresenceRangeKey に正規化する。 */
export function normalizePresenceRangeKey(raw: unknown): PresenceRangeKey {
  return PRESENCE_RANGE_KEYS.includes(raw as PresenceRangeKey)
    ? (raw as PresenceRangeKey)
    : DEFAULT_PRESENCE_RANGE;
}

/**
 * `?range=` を from/to に解決する。`now` は実行時刻（テストでは固定値を渡す）。
 * `to` は `now + 1 分`（境界で当日最新の検知を含める）。`from` は days 日前 0 時起点でなく
 * 「now - days」のスライディング窓（直近 N 日 = ちょうど N×24h）。`all` は from=エポック。
 */
export function resolvePresenceRange(raw: unknown, now: Date): ResolvedPresenceRange {
  const key = normalizePresenceRangeKey(raw);
  const spec = RANGE_SPEC[key];
  const to = new Date(now.getTime() + 60_000);
  const from =
    spec.days === null ? new Date(0) : new Date(now.getTime() - spec.days * 24 * 60 * 60 * 1000);
  return { key, label: spec.label, from, to };
}

/** UI のプリセット切替リンク用（key + ラベル + 選択中フラグ）。 */
export function presenceRangeOptions(
  current: PresenceRangeKey,
): Array<{ key: PresenceRangeKey; label: string; active: boolean }> {
  return PRESENCE_RANGE_KEYS.map((key) => ({
    key,
    label: RANGE_SPEC[key].label,
    active: key === current,
  }));
}
