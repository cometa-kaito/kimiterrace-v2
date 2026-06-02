import { and, eq, isNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { KimiterraceDb } from "../client.js";
import { withTenantContext } from "../client.js";
import { auditLog } from "../schema/audit-log.js";
import { events } from "../schema/events.js";
import { sensorDevices } from "../schema/sensor-devices.js";

/** SELECT だけできれば良い (Drizzle db / トランザクションの両方を受ける、event-stats と同方針)。 */
type Selectable = Pick<PostgresJsDatabase, "select">;

/**
 * F13 (#408, ADR-020): SwitchBot Webhook の presence イベント書込みドメインサービス。
 *
 * webhook は **ユーザーセッション無し**の公開経路で、`sensor_devices` は RLS 保護下。MAC は全校横断で
 * 一意に引く必要があるが、**BYPASSRLS は使わない**（ルール2）。ADR-019 二層 RLS に沿って:
 *   1. `system_admin` role context（`system_admin_full_access` policy）で `device_mac → school_id`
 *      を **cross-tenant 解決**。`device_mac` は #400 で**グローバル UNIQUE**にしたため必ず 1 行に解決し、
 *      同一 MAC を 2 校が登録できない＝テナント越境ルーティングを構造的に防ぐ（`sensor-devices.ts` doc）。
 *   2. 解決した `school_id` を明示して `events`(type='presence') と `audit_log` を書込む（同 tx、原子的）。
 *      監査の actor は null（システム/webhook）。null actor は `system_admin` role でのみ許可される
 *      （`audit_log_insert` policy, migrations/0002）ため、書込みも system_admin context で行う。
 *
 * 監査（ルール1）/ PII 非格納（ルール4: payload は device/検知メタのみ、個人識別情報なし）/ 冪等（再送 dedup）。
 *
 * @param db       非 BYPASSRLS の Drizzle クライアント（本番 `getDb()`）。
 * @param input    正規化済みの presence 入力（`deviceMac` は大文字・区切り無し）。
 * @param options  `appRole`: テスト superuser 接続を `kimiterrace_app` へ降格させ RLS を効かせる用
 *                 （本番接続は最初から kimiterrace_app のため未指定でよい）。
 */
export type PresenceIngestInput = {
  /** 正規化済み device MAC（大文字・区切り無し）。 */
  deviceMac: string;
  detectionState: string | null;
  /** 検知時刻（epoch ms）。null なら DB 受信時刻 now()。冪等 dedup キーにもなる。 */
  timeOfSampleMs: number | null;
  eventVersion: string | null;
};

export type PresenceIngestResult =
  | { status: "recorded"; schoolId: string; eventId: string }
  | { status: "duplicate"; schoolId: string }
  | { status: "unknown_device" };

export async function recordPresenceEvent(
  db: KimiterraceDb,
  input: PresenceIngestInput,
  options?: { appRole?: string },
): Promise<PresenceIngestResult> {
  return await withTenantContext(
    db,
    { role: "system_admin" },
    async (tx): Promise<PresenceIngestResult> => {
      // 1. cross-tenant 解決（system_admin_full_access 経由、BYPASSRLS 不使用）。
      //    登録 MAC の表記ゆれ（区切りの有無）を吸収するため、保存値も同じ正規形に潰して照合する。
      //    decommissioned 済デバイスは計上しない（到達/検知の水増し防止）。
      const resolvedRows = await tx
        .select({ schoolId: sensorDevices.schoolId, classId: sensorDevices.classId })
        .from(sensorDevices)
        .where(
          and(
            sql`upper(replace(replace(${sensorDevices.deviceMac}, ':', ''), '-', '')) = ${input.deviceMac}`,
            isNull(sensorDevices.decommissionedAt),
          ),
        )
        .limit(1);
      const resolved = resolvedRows[0];
      if (!resolved) return { status: "unknown_device" };

      // 解決校を pin（監査スコープ + 防御的明示。system_admin なので policy 上は必須でないが意図を固定）。
      await tx.execute(sql`select set_config('app.current_school_id', ${resolved.schoolId}, true)`);

      // occurred_at は DB 側で epoch ms → timestamptz に変換。JS Date を enum 列を含む INSERT に bind
      // しない（postgres@3.4.9 の ERR_INVALID_ARG_TYPE 回避）。
      const occurredAtSql =
        input.timeOfSampleMs != null
          ? sql`to_timestamp(${input.timeOfSampleMs}::double precision / 1000)`
          : null;

      // 2. 冪等: SwitchBot 再送の二重計上を防ぐ。タイムスタンプがある場合のみ (device_mac, occurred_at) で dedup。
      if (occurredAtSql != null) {
        const dup = await tx
          .select({ id: events.id })
          .from(events)
          .where(
            and(
              eq(events.type, "presence"),
              sql`${events.payload}->>'device_mac' = ${input.deviceMac}`,
              sql`${events.occurredAt} = ${occurredAtSql}`,
            ),
          )
          .limit(1);
        if (dup.length > 0) return { status: "duplicate", schoolId: resolved.schoolId };
      }

      // 3. events に presence を書込。PII 非格納（device/検知メタのみ、ルール4）。events に class_id 列は
      //    無いため class_id は payload へ（F08 ヒートマップのクラス別集計用、school 内 id で PII ではない）。
      const inserted = await tx
        .insert(events)
        .values({
          schoolId: resolved.schoolId,
          type: "presence",
          ...(occurredAtSql != null ? { occurredAt: occurredAtSql } : {}),
          payload: {
            source: "switchbot",
            device_mac: input.deviceMac,
            detection_state: input.detectionState,
            time_of_sample_ms: input.timeOfSampleMs,
            event_version: input.eventVersion,
            class_id: resolved.classId,
          },
        })
        .returning({ id: events.id });
      const eventId = inserted[0]?.id;
      if (eventId === undefined) {
        // INSERT ... RETURNING は必ず 1 行返すため通常起きない。防御的に loud fail させる。
        throw new Error("recordPresenceEvent: events INSERT が行を返しませんでした");
      }

      // 4. 監査（ルール1）: actor=null（システム）。row_hash はトリガが計算（"" を上書き）。
      await tx.insert(auditLog).values({
        actorUserId: null,
        schoolId: resolved.schoolId,
        tableName: "events",
        recordId: eventId,
        operation: "insert",
        diff: {
          type: "presence",
          device_mac: input.deviceMac,
          detection_state: input.detectionState,
        },
        rowHash: "",
      });

      return { status: "recorded", schoolId: resolved.schoolId, eventId };
    },
    options,
  );
}

/** 管理画面の sensor 一覧 1 行（登録済み在室検知デバイス + 最終検知時刻）。 */
export type SensorDeviceListItem = {
  id: string;
  /** デバイス MAC（登録時の表記そのまま。schema 注記の通り PII ではない）。 */
  deviceMac: string;
  /** 設置場所ラベル（自由文字列、PII 非格納）。未設定は null。 */
  locationLabel: string | null;
  vendor: string;
  kind: string;
  /** 紐付けクラス（任意）。未紐付けは null。 */
  classId: string | null;
  /** 設置日時（drizzle mode:"date" で Date）。 */
  installedAt: Date | null;
  /** 撤去日時。null = 稼働中（active）、値あり = 撤去済（decommissioned）。 */
  decommissionedAt: Date | null;
  /**
   * このデバイス由来の presence イベントの最新 occurred_at（ISO 文字列）。一度も検知が無ければ null。
   * timestamptz を `::text` で文字列化して返す（postgres ドライバの timestamptz 文字列返却差を避け、
   * 表示層が `new Date(...)` で扱う前提）。
   */
  lastSeenAt: string | null;
};

/**
 * 自校の登録センサー（`sensor_devices`）を最終検知時刻つきで一覧する（RLS で school スコープ）。F13
 * `/admin/sensors` 管理画面の読み取り slice。撤去済みも含めて返し、稼働中（decommissioned_at IS NULL）→
 * 撤去済の順、同区分内は device_mac 昇順で決定的に並べる。
 *
 * - **テナント分離（ルール2）**: `school_id` を書かず `sensor_devices` の RLS（`tenant_isolation`）に委譲。
 *   school_admin / teacher context では自校のみ可視。空コンテキストは deny-by-default で 0 件。
 * - **最終検知**: presence イベント（`events.type='presence'`）の `payload->>'device_mac'` が webhook で
 *   正規化された MAC（大文字・区切り無し）であるため、`sensor_devices.device_mac` を同じ正規形に潰して
 *   相関サブクエリで突き合わせ、最新 `occurred_at` を取る。`events` も同 RLS context で自校スコープ。
 * - **PII（ルール4）**: 件数・時刻・デバイスメタのみ。`events.payload` の他フィールドや個人識別情報は読まない。
 */
export async function listSensorDevices(db: Selectable): Promise<SensorDeviceListItem[]> {
  // sensor_devices.device_mac を webhook 正規形（大文字・コロン/ハイフン除去）に潰す式。presence イベントの
  // payload->>'device_mac' は同正規形で書かれる（recordPresenceEvent / sensor-devices.ts 注記）。
  const normalizedMac = sql`upper(replace(replace(${sensorDevices.deviceMac}, ':', ''), '-', ''))`;
  const lastSeenAt = sql<
    string | null
  >`(select max(occurred_at)::text from ${events} where type = 'presence' and payload->>'device_mac' = ${normalizedMac})`;

  const rows = await db
    .select({
      id: sensorDevices.id,
      deviceMac: sensorDevices.deviceMac,
      locationLabel: sensorDevices.locationLabel,
      vendor: sensorDevices.vendor,
      kind: sensorDevices.kind,
      classId: sensorDevices.classId,
      installedAt: sensorDevices.installedAt,
      decommissionedAt: sensorDevices.decommissionedAt,
      lastSeenAt,
    })
    .from(sensorDevices)
    // 稼働中（decommissioned_at IS NULL）を先頭、その後撤去済。区分内は device_mac 昇順で決定的に。
    .orderBy(sql`${sensorDevices.decommissionedAt} nulls first`, sensorDevices.deviceMac);

  return rows.map((r) => ({
    id: r.id,
    deviceMac: r.deviceMac,
    locationLabel: r.locationLabel,
    vendor: r.vendor,
    kind: r.kind,
    classId: r.classId,
    installedAt: r.installedAt,
    decommissionedAt: r.decommissionedAt,
    lastSeenAt: r.lastSeenAt,
  }));
}
