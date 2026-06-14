import { type InferSelectModel, and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { tvDeviceDowntime } from "../schema/tv-device-downtime.js";
import { tvDevices } from "../schema/tv-devices.js";

/**
 * F16 (ADR-023): TV ダウンタイム履歴 / 稼働サマリの **読み取りクエリ層**（RLS 委譲）。
 *
 * `tv_device_downtime`（死活チェッカが populate、PR #492）を管理 UI（F16 §5）向けに射影する。
 * 2 つの読み取りがある:
 *  1. **履歴**: `listTvDeviceDowntime` — ある TV の直近アウテージ（いつ落ちた / いつ復帰 / 何秒 / 原因）を
 *     新しい順に返す。継続中（`recovered_at IS NULL`）も含む。
 *  2. **稼働サマリ**: `getTvUptimeSummary` — 指定窓（直近 N 日）内の総ダウン秒数とアウテージ件数を
 *     **DB 側 `now()` 基準**で集計する。継続中アウテージは「went_down_at〜now」で算出し計上に取りこぼさない。
 *
 * ## RLS 委譲（ルール2）
 * 可視範囲は `tv_device_downtime` の RLS が DB レベルで決める（school_admin=自校 / system_admin=全校）。
 * **手書きの `WHERE school_id` は書かない**（schools.ts / tv-devices.ts と同方針）。呼び出し側は
 * 非 BYPASSRLS 接続（`kimiterrace_app`）の RLS context tx でこれらを呼ぶこと。
 *
 * ## 決定的順序（PR #492 / #499 の教訓）
 * 履歴は `desc(went_down_at)` だけだと同時刻アウテージで順序が非決定になる（single-key ORDER BY tie は
 * 非決定）。`desc(went_down_at), desc(id)` の複合キーで一意な tiebreak を与え、ページング・スナップショット
 * 検証を安定させる。
 *
 * ## timestamptz の読み取り（[[pg-timestamptz-read-string]]）
 * schema が timestamptz を `mode: "date"` で宣言しているため、Drizzle の select マッピングは Date を返す。
 * 本層は Drizzle マッピングをそのまま返すので呼び出し側で `new Date(...)` ラップは不要。一方サマリの集計
 * （EXTRACT(EPOCH ...)）は `::int` で int 化し JS では number で受ける。
 *
 * 型は schema の `tvDeviceDowntime` から `InferSelectModel` で派生する（ルール3、手書きドメイン型は作らない）。
 */

type TvDowntimeRow = InferSelectModel<typeof tvDeviceDowntime>;
type TvDeviceRow = InferSelectModel<typeof tvDevices>;

/** SELECT だけできれば良い（Drizzle db / RLS context tx の両方を受ける）。 */
type Selectable = Pick<PostgresJsDatabase, "select">;

/**
 * 履歴ページのヘッダ表示 + ダウンタイム解決に要る TV 識別の最小射影。履歴ページは URL の行 PK
 * （`tv_devices.id`、編集ページと同じ参照軸）を受け取るが、`tv_device_downtime` は `device_id`（text）で
 * FK 参照するため、行 PK → device_id を RLS スコープ下で解決する。設定の生値（webhook_url 等）は含めない。
 * `scheduleJson` は推定原因の表示（消灯時間帯かの判定、`apps/web` の estimateDowntimeCause）に使う
 * 非 PII・非 secret の表示設定（schedule の ON/OFF 窓のみ。ルール4 に抵触しない）。
 */
export type TvDeviceIdentity = Pick<
  TvDeviceRow,
  "id" | "deviceId" | "label" | "lastBootAt" | "monitoringEnabled" | "alertState" | "scheduleJson"
>;

/**
 * 履歴ページ用に 1 デバイスの識別情報を **行 PK（`tv_devices.id`）** で取得する（F16 §5）。
 *
 * 可視範囲は `tv_devices` の RLS が決める（他校 / 退役 TV は不可視 → undefined → 呼び出し側で `notFound()`）。
 * `WHERE deleted_at IS NULL` は対象絞り込み（退役 TV の履歴ページは出さない）であってテナント境界ではない
 * （越境は RLS が弾く、ルール2）。手書きの `WHERE school_id` は書かない。返した `deviceId` を
 * {@link listTvDeviceDowntime} / {@link getTvUptimeSummary} に渡してダウンタイム履歴を引く。
 *
 * @param db  非 BYPASSRLS の Drizzle クライアント / RLS context tx。
 * @param id  対象 TV の行 PK（`tv_devices.id`、一覧の編集リンクと同じ参照軸）。
 */
export async function getTvDeviceIdentity(
  db: Selectable,
  id: string,
): Promise<TvDeviceIdentity | undefined> {
  const rows = await db
    .select({
      id: tvDevices.id,
      deviceId: tvDevices.deviceId,
      label: tvDevices.label,
      lastBootAt: tvDevices.lastBootAt,
      monitoringEnabled: tvDevices.monitoringEnabled,
      alertState: tvDevices.alertState,
      scheduleJson: tvDevices.scheduleJson,
    })
    .from(tvDevices)
    .where(and(eq(tvDevices.id, id), isNull(tvDevices.deletedAt)))
    .limit(1);
  return rows[0];
}

/**
 * ダウンタイム履歴 1 行（管理 UI 表示用の射影）。運用メモ（notes）・監査列・school_id は表示に不要なため
 * 含めない（履歴は「いつ・どれだけ・なぜ」だけ示す）。`recoveredAt`/`durationSec` が NULL の行は継続中
 * （まだ復帰観測されていないアウテージ）= UI 側で「継続中」と明示する。
 */
export type TvDowntimeHistoryRow = Pick<
  TvDowntimeRow,
  "id" | "deviceId" | "wentDownAt" | "recoveredAt" | "durationSec" | "causeHint"
>;

/** 履歴取得のデフォルト返却件数上限（管理 UI の直近表示。暴走クエリ防止）。 */
export const DEFAULT_DOWNTIME_HISTORY_LIMIT = 100;

/**
 * ある TV の直近ダウンタイム履歴を新しい順に返す（F16 §5）。
 *
 * 並びは `desc(went_down_at), desc(id)` の複合キー（同時刻 tie の決定化、PR #492/#499 教訓）。継続中
 * （`recovered_at IS NULL`）の行も含めて返し、UI 側で「継続中」と表示する。可視範囲は RLS が決める
 * （手書き `WHERE school_id` 無し、ルール2）。`device_id` の絞り込みは対象指定であってテナント境界ではない。
 *
 * @param db        非 BYPASSRLS の Drizzle クライアント / RLS context tx。
 * @param deviceId  対象 TV の `tv_devices.device_id`（ダウンタイム行の FK 先）。
 * @param limit     返却上限（既定 {@link DEFAULT_DOWNTIME_HISTORY_LIMIT}）。
 */
export async function listTvDeviceDowntime(
  db: Selectable,
  deviceId: string,
  limit: number = DEFAULT_DOWNTIME_HISTORY_LIMIT,
): Promise<TvDowntimeHistoryRow[]> {
  return (
    db
      .select({
        id: tvDeviceDowntime.id,
        deviceId: tvDeviceDowntime.deviceId,
        wentDownAt: tvDeviceDowntime.wentDownAt,
        recoveredAt: tvDeviceDowntime.recoveredAt,
        durationSec: tvDeviceDowntime.durationSec,
        causeHint: tvDeviceDowntime.causeHint,
      })
      .from(tvDeviceDowntime)
      .where(eq(tvDeviceDowntime.deviceId, deviceId))
      // 同時刻アウテージの tie を id で決定化（single-key ORDER BY tie は非決定、PR #492/#499 教訓）。
      .orderBy(desc(tvDeviceDowntime.wentDownAt), desc(tvDeviceDowntime.id))
      .limit(limit)
  );
}

/** 稼働サマリ（指定窓内の総ダウン秒数 + アウテージ件数）。窓は DB 側 now() 基準。 */
export type TvUptimeSummary = {
  /** 集計対象 TV の device_id。 */
  deviceId: string;
  /** 窓の日数（呼び出しが指定した N。表示で「直近 N 日」に使う）。 */
  windowDays: number;
  /** 窓内に開始したアウテージ件数（継続中も含む）。 */
  outageCount: number;
  /**
   * 窓内の総ダウン秒数。復帰済みは `duration_sec`、継続中（recovered_at IS NULL）は `now() - went_down_at`
   * を DB 側で算出して足す（継続中アウテージの経過分を取りこぼさない）。0 件なら 0。
   */
  totalDowntimeSec: number;
};

/** 稼働サマリ窓のデフォルト日数（F16 §5「直近 7d」）。 */
export const DEFAULT_UPTIME_WINDOW_DAYS = 7;

/**
 * ある TV の指定窓（直近 `windowDays` 日）内の稼働サマリ（総ダウン秒数 + アウテージ件数）を **DB 側 `now()`
 * 基準**で集計する（F16 §5）。
 *
 * - 窓: `went_down_at >= now() - windowDays 日`（DB 側算出。JS Date を bind しない＝
 *   [[pg-date-bind-enum-insert]] / セッション TZ 非依存）。
 * - 総ダウン秒数: 復帰済みは `duration_sec`、継続中（`recovered_at IS NULL`）は `now() - went_down_at` を
 *   秒に換算（非負・四捨五入）して合算する。アウテージ 0 件なら 0 を返す（COALESCE）。
 * - 可視範囲は RLS が決める（手書き `WHERE school_id` 無し、ルール2）。
 *
 * @param db          非 BYPASSRLS の Drizzle クライアント / RLS context tx。
 * @param deviceId    対象 TV の `tv_devices.device_id`。
 * @param windowDays  集計窓の日数（既定 {@link DEFAULT_UPTIME_WINDOW_DAYS}）。
 */
export async function getTvUptimeSummary(
  db: Selectable,
  deviceId: string,
  windowDays: number = DEFAULT_UPTIME_WINDOW_DAYS,
): Promise<TvUptimeSummary> {
  const rows = await db
    .select({
      outageCount: sql<number>`count(*)::int`,
      // 復帰済みは duration_sec、継続中は now() - went_down_at（秒・非負・四捨五入）を足す。窓内 0 件なら 0。
      totalDowntimeSec: sql<number>`COALESCE(SUM(
        CASE
          WHEN ${tvDeviceDowntime.recoveredAt} IS NOT NULL THEN ${tvDeviceDowntime.durationSec}
          ELSE GREATEST(0, ROUND(EXTRACT(EPOCH FROM (now() - ${tvDeviceDowntime.wentDownAt})))::int)
        END
      ), 0)::int`,
    })
    .from(tvDeviceDowntime)
    .where(
      and(
        eq(tvDeviceDowntime.deviceId, deviceId),
        // 窓は DB 側 now() 基準（JS Date を bind しない、セッション TZ 非依存）。
        gte(tvDeviceDowntime.wentDownAt, sql`now() - make_interval(days => ${windowDays}::int)`),
      ),
    );

  const row = rows[0];
  return {
    deviceId,
    windowDays,
    outageCount: row?.outageCount ?? 0,
    totalDowntimeSec: row?.totalDowntimeSec ?? 0,
  };
}
