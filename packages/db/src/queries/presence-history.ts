import { and, desc, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { events } from "../schema/events.js";
import { sensorDevices } from "../schema/sensor-devices.js";

/**
 * F13 (#391, ADR-020): 1 センサーの **来場検知（presence）履歴**読み取り層。**SELECT のみ**。
 *
 * `sensor-devices-status.ts`（デバイス台帳 + 直近検知 + ヘルス）が「いま各センサーが生きているか」の
 * 俯瞰なのに対し、本モジュールは **特定 1 センサーの過去の検知を時系列で全部見る**ための read モデル。
 * 管理画面 `/ops/sensors/[id]/history` が消費する（ユーザー依頼「人感センサのデータを過去のデータなど
 * 全て UI から見れるように」）。
 *
 * 返すのは ①期間内の生検知イベント（occurred_at + detection_state、新しい順・上限つき）、②**JST 日別**の
 * 検知数、③期間内総数、の 3 つ。集計は時間バケットでなく日単位の素朴なカウントに留める（在室ヒートマップ
 * の時間帯集計は #476 event-stats.ts の責務、ここは重複させない）。
 *
 * ## テナント分離（ルール2 / ADR-019）
 * `school_id` 条件を**書かない**。`events` / `sensor_devices` の RLS（tenant_isolation /
 * system_admin_full_access）が DB レベルで可視範囲を強制する。`sensor_devices` を INNER JOIN するため、
 * 対象センサーが自校（school_admin）or 全校（system_admin）で可視な時のみ行が返り、不可視なら 0 行。
 * 呼出側は非 BYPASSRLS 接続（apps/web の `withSession`）で実行すること。
 *
 * ## PII 非格納 / 匿名（ルール4 / ADR-020）
 * PIR はカメラ非搭載・個人識別なし。返すのは検知時刻・検知状態（DETECTED 等の匿名メタ）・件数のみ。
 * 個人別 / 端末別の粒度には落とさない。
 *
 * ## device_mac 表記ゆれ吸収 / 時刻
 * presence の `payload.device_mac`（webhook で正規形保存）と `sensor_devices.device_mac`（登録時表記）を
 * 両辺正規形へ畳んで JOIN する（status クエリと同式）。日別集計は **JST**（`at time zone 'Asia/Tokyo'`）で
 * 行う（クライアント時刻不信・暦日は JST 基準、event-stats と同思想）。
 */

/** SELECT だけできれば良い（Drizzle db / トランザクションの両方を受ける）。 */
type Selectable = Pick<PostgresJsDatabase, "select">;

/** 期間内の生検知イベント 1 件（匿名メタのみ）。 */
export type PresenceHistoryEvent = {
  /** events.id（UI の安定キー用。個人を識別しないイベント行 PK）。 */
  id: string;
  /** 検知時刻（timestamptz）。 */
  occurredAt: Date;
  /** 検知状態（payload.detection_state、例 "DETECTED"）。未設定は null。 */
  detectionState: string | null;
};

/** JST 日別の検知数。 */
export type PresenceDailyCount = {
  /** JST の暦日（YYYY-MM-DD）。 */
  day: string;
  /** その日の検知数。 */
  count: number;
};

/** presence 履歴の読み取り結果。 */
export type PresenceHistory = {
  /** 期間内の生検知（新しい順・最大 limit 件）。 */
  events: PresenceHistoryEvent[];
  /** JST 日別の検知数（昇順）。 */
  dailyCounts: PresenceDailyCount[];
  /** 期間内の総検知数（events 上限とは無関係の実数）。 */
  totalInRange: number;
  /** events が上限に達して切り詰められたか（UI で「最新 N 件のみ表示」を出す）。 */
  truncated: boolean;
};

export type PresenceHistoryParams = {
  /** 対象 `sensor_devices.id`。 */
  sensorId: string;
  /** 期間の開始（含む）。 */
  from: Date;
  /** 期間の終了（含まない）。 */
  to: Date;
  /** 生検知リストの上限（既定 500）。総数 totalInRange は別途実数を返す。 */
  limit?: number;
};

const DEFAULT_LIMIT = 500;

/**
 * 指定センサーの presence 履歴（生検知・日別集計・総数）を取得する。RLS context を張った tx で呼ぶ。
 * 対象センサーが不可視（他校 / 不存在）なら events=[], dailyCounts=[], totalInRange=0 を返す。
 */
export async function getPresenceHistory(
  db: Selectable,
  params: PresenceHistoryParams,
): Promise<PresenceHistory> {
  const limit = params.limit ?? DEFAULT_LIMIT;
  // device_mac 正規形（両辺を upper(replace(...)) に畳む）で presence を 1 センサーに結合する。
  const eventMacNorm = sql`upper(replace(replace(${events.payload}->>'device_mac', ':', ''), '-', ''))`;
  const deviceMacNorm = sql`upper(replace(replace(${sensorDevices.deviceMac}, ':', ''), '-', ''))`;
  const joinOn = sql`${events.type} = 'presence' and ${eventMacNorm} = ${deviceMacNorm}`;
  // 範囲は明示 ::timestamptz キャストで bind（postgres@3 の Date bind 罠を避け、ISO 文字列で渡す）。
  const fromIso = params.from.toISOString();
  const toIso = params.to.toISOString();
  const inRange = and(
    eq(sensorDevices.id, params.sensorId),
    sql`${events.occurredAt} >= ${fromIso}::timestamptz`,
    sql`${events.occurredAt} < ${toIso}::timestamptz`,
  );

  // ① 生検知（新しい順、上限 +1 で切り詰め検出）。
  const rawRows = await db
    .select({
      id: events.id,
      occurredAt: events.occurredAt,
      detectionState: sql<string | null>`${events.payload}->>'detection_state'`,
    })
    .from(events)
    .innerJoin(sensorDevices, joinOn)
    .where(inRange)
    .orderBy(desc(events.occurredAt))
    .limit(limit + 1);

  const truncated = rawRows.length > limit;
  const eventsOut: PresenceHistoryEvent[] = rawRows.slice(0, limit).map((r) => ({
    id: r.id,
    // postgres ドライバは timestamptz を文字列で返す場合があるため Date 化（[[feedback_pg_timestamptz_read_string]]）。
    occurredAt: new Date(r.occurredAt as unknown as string),
    detectionState: r.detectionState,
  }));

  // ② JST 日別の検知数（昇順）。
  const dayExpr = sql<string>`to_char((${events.occurredAt} at time zone 'Asia/Tokyo')::date, 'YYYY-MM-DD')`;
  const dailyRows = await db
    .select({ day: dayExpr, count: sql<number>`count(*)`.mapWith(Number) })
    .from(events)
    .innerJoin(sensorDevices, joinOn)
    .where(inRange)
    .groupBy(dayExpr)
    .orderBy(sql`${dayExpr} asc`);

  // ③ 期間内総数（生検知の上限と無関係の実数）。
  const totalRows = await db
    .select({ total: sql<number>`count(*)`.mapWith(Number) })
    .from(events)
    .innerJoin(sensorDevices, joinOn)
    .where(inRange);

  return {
    events: eventsOut,
    dailyCounts: dailyRows.map((r) => ({ day: r.day, count: r.count })),
    totalInRange: totalRows[0]?.total ?? 0,
    truncated,
  };
}
