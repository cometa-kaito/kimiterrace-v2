import { eq, sql } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { classes } from "../schema/classes.js";
import { events } from "../schema/events.js";
import { sensorDevices } from "../schema/sensor-devices.js";

/**
 * F13 (#391, ADR-020): 来場検知センサーの **管理 / 状態一覧**読み取り層。**SELECT のみ**。
 *
 * 管理者が「自校に登録された人感センサー (#391 で作成した `sensor_devices`)」を一望し、
 * 各センサーが「最後にいつ検知したか」「電池切れ等で沈黙していないか」を運用画面で確認する
 * ための read モデルを返す (F13 §3.1 センサー管理画面 / ユーザーストーリー「いつ最後に応答したか」)。
 *
 * ## ★ #476 ヒートマップとは別物 (非重複)
 * #476 (`event-stats.ts` の `getHourlyEventCounts` 等) は presence イベントの **時間帯別カウント集計**
 * (在室ヒートマップ・時系列) を担う。本モジュールは集計ではなく **デバイス台帳 + ヘルス状態** を返す
 * — 1 行 = 1 センサーで、presence イベントは「直近検知時刻」「直近 24h 検知数」を出すために
 * **デバイス側へ LEFT JOIN で畳み込む**だけ。時系列・バケット集計は一切しない。
 *
 * ## テナント分離 (CLAUDE.md ルール2)
 * `school_id` 条件を**書かない** — 呼び出し接続の RLS コンテキスト (`app.current_school_id` /
 * `app.current_user_role`、ADR-019) が DB レベルでテナント境界を強制する。`sensor_devices` の
 * `tenant_isolation` policy が SELECT を自校行に絞り (school_admin)、`system_admin_full_access` が
 * 全校可視にする (system_admin)。LEFT JOIN 先 `events` (type='presence') / `classes` も同 policy で
 * 絞られるため、他校のセンサー・他校の検知・他校のクラス名が混ざることはない (多層防御)。
 * 呼び出し側 (apps/web の `withSession`) が **非 BYPASSRLS** 接続 (kimiterrace_app) で実行すること。
 *
 * ## PII 非格納 / 匿名 (ルール4 / ADR-020 透明性要件)
 * PIR センサーはカメラ非搭載・個人識別なし。本クエリも個人を識別する情報は一切返さない。
 * presence イベントは匿名の検知メタのみで、返すのは **件数 (整数)** と検知時刻のみ。
 * 個人別/端末別の粒度には落とさない (event-stats.ts と同方針)。
 *
 * ## 時刻はすべて DB の now() 基準 (クライアント時刻不信)
 * ヘルス判定の鮮度しきい値・直近 24h 窓は **DB 側 `now()`** で評価する。アプリ/クライアントの
 * 時計を信用しない (F07 / event-stats.ts と同じ思想、なりすまし・時計ずれ回避)。
 *
 * ## device_mac の表記ゆれ吸収
 * presence イベントの `payload.device_mac` は webhook 取り込み (`sensor-presence.ts`) で
 * **正規形 (大文字・区切り無し)** に潰して保存される。一方 `sensor_devices.device_mac` は
 * 登録時の表記 (コロン区切り等) のままのため、JOIN 条件は両辺を同じ正規形へ畳んで突き合わせる。
 */

/** SELECT だけできれば良い (Drizzle db / トランザクションの両方を受ける)。 */
type Selectable = Pick<PostgresJsDatabase, "select">;

/** sensor_devices の行型 (Drizzle スキーマ単一ソース、ルール3)。 */
type SensorDeviceRow = InferSelectModel<typeof sensorDevices>;

/**
 * センサーの稼働ヘルス状態 (F13 §3.1)。サーバ側 (DB の now() 基準) で判定し、UI は
 * 色 **+** テキスト両方で示す (NFR05 色だけに依存しない)。
 *   - `healthy`：直近 24h 以内に検知あり
 *   - `quiet`  ：24h 検知なしだが 7 日以内に検知あり (夏休み・休日等のグレーゾーン)
 *   - `dead`   ：7 日以上検知なし (検知履歴はある)
 *   - `never`  ：一度も検知がない (設置直後 / 配線未完など。F13 §3.1 の 3 区分に「未検知」を補う)
 */
export type SensorHealthStatus = "healthy" | "quiet" | "dead" | "never";

/** 鮮度しきい値 (時間)。healthy ≤ 24h、quiet ≤ 7 日 = 168h、超過は dead。 */
export const SENSOR_HEALTHY_WINDOW_HOURS = 24;
export const SENSOR_QUIET_WINDOW_HOURS = 24 * 7;

/** センサー管理一覧の 1 行 (= 1 センサー + そのヘルス)。 */
export type SensorDeviceStatus = {
  id: SensorDeviceRow["id"];
  /** 物理 MAC (登録時の表記そのまま)。UI 側で末尾 4 文字マスク等を行う (F13 §4)。 */
  deviceMac: SensorDeviceRow["deviceMac"];
  /** 設置場所ラベル (教室名等。PII を含めない、ADR-020)。未設定は null。 */
  locationLabel: SensorDeviceRow["locationLabel"];
  /** 紐づくクラスの id (未紐付けは null)。 */
  classId: SensorDeviceRow["classId"];
  /** 紐づくクラス名 (classes.name。未紐付け / クラス削除済は null)。 */
  className: string | null;
  /** 設置日時 (timestamptz)。 */
  installedAt: SensorDeviceRow["installedAt"];
  /** 撤去日時 (NULL = 稼働中)。撤去済も一覧には出すが状態欄で明示する。 */
  decommissionedAt: SensorDeviceRow["decommissionedAt"];
  /** 直近の presence 検知時刻 (timestamptz)。一度も検知が無ければ null。 */
  lastDetectedAt: Date | null;
  /** 直近 24h (DB now() 基準) の presence 検知数。 */
  detections24h: number;
  /** サーバ判定の稼働ヘルス (DB now() 基準)。撤去済 (decommissioned) でも履歴ベースで判定する。 */
  status: SensorHealthStatus;
};

/**
 * 自校 (RLS スコープ) の登録センサーを、直近検知時刻 + ヘルス状態つきで列挙する。
 *
 * 並びは決定的にする: 稼働中 (decommissioned が NULL) を先、次に直近検知が新しい順
 * (未検知 = NULL は末尾)、最後に id 昇順。これにより同条件でも順序が安定する。
 *
 * @param db RLS context を張った非 BYPASSRLS 接続 (apps/web の `withSession` 経由)。
 */
export async function listSensorDeviceStatuses(db: Selectable): Promise<SensorDeviceStatus[]> {
  // presence イベント側の device_mac を正規形へ畳む式 (payload は jsonb)。
  const eventMacNorm = sql`upper(replace(replace(${events.payload}->>'device_mac', ':', ''), '-', ''))`;
  // sensor_devices 側の device_mac を同じ正規形へ畳む式。
  const deviceMacNorm = sql`upper(replace(replace(${sensorDevices.deviceMac}, ':', ''), '-', ''))`;
  // presence かつ MAC 一致でのみ JOIN する (LEFT JOIN なので未検知センサーは NULL で残る)。
  const presenceJoinOn = sql`${events.type} = 'presence' and ${eventMacNorm} = ${deviceMacNorm}`;

  // 直近検知時刻 (検知が無ければ NULL)。
  const lastDetectedAt = sql<Date | null>`max(${events.occurredAt})`;
  // 直近 24h の検知数。窓は DB の now() 基準 (クライアント時刻不信)。
  const detections24h =
    sql<number>`count(*) filter (where ${events.occurredAt} >= now() - make_interval(hours => ${SENSOR_HEALTHY_WINDOW_HOURS}::int))`.mapWith(
      Number,
    );
  // ヘルス状態 (DB now() 基準)。検知無し → never、≤24h → healthy、≤7日 → quiet、それ以外 → dead。
  const status = sql<SensorHealthStatus>`case
    when max(${events.occurredAt}) is null then 'never'
    when max(${events.occurredAt}) >= now() - make_interval(hours => ${SENSOR_HEALTHY_WINDOW_HOURS}::int) then 'healthy'
    when max(${events.occurredAt}) >= now() - make_interval(hours => ${SENSOR_QUIET_WINDOW_HOURS}::int) then 'quiet'
    else 'dead'
  end`;

  const rows = await db
    .select({
      id: sensorDevices.id,
      deviceMac: sensorDevices.deviceMac,
      locationLabel: sensorDevices.locationLabel,
      classId: sensorDevices.classId,
      className: classes.name,
      installedAt: sensorDevices.installedAt,
      decommissionedAt: sensorDevices.decommissionedAt,
      lastDetectedAt,
      detections24h,
      status,
    })
    .from(sensorDevices)
    // presence イベントを MAC 正規形で畳み込む (LEFT JOIN: 未検知センサーも 1 行残す)。
    .leftJoin(events, presenceJoinOn)
    // クラス名解決 (未紐付け / 削除済は NULL)。クラスも RLS で自校に絞られる。
    .leftJoin(classes, eq(sensorDevices.classId, classes.id))
    .groupBy(
      sensorDevices.id,
      sensorDevices.deviceMac,
      sensorDevices.locationLabel,
      sensorDevices.classId,
      classes.name,
      sensorDevices.installedAt,
      sensorDevices.decommissionedAt,
    )
    // 稼働中を先 (decommissioned が NULL → 0)、直近検知が新しい順 (NULL = 未検知は末尾)、id 昇順。
    .orderBy(
      sql`(${sensorDevices.decommissionedAt} is not null)`,
      sql`${lastDetectedAt} desc nulls last`,
      sensorDevices.id,
    );

  return rows.map((r) => ({
    id: r.id,
    deviceMac: r.deviceMac,
    locationLabel: r.locationLabel,
    classId: r.classId,
    className: r.className,
    installedAt: r.installedAt,
    decommissionedAt: r.decommissionedAt,
    // postgres ドライバは timestamptz を文字列で返すため Date 化する (実 PG のみ)。NULL は維持。
    lastDetectedAt: r.lastDetectedAt == null ? null : new Date(r.lastDetectedAt),
    detections24h: r.detections24h,
    status: r.status,
  }));
}
