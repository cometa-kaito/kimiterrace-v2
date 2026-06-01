import { and, eq, isNull, sql } from "drizzle-orm";
import type { KimiterraceDb } from "../client.js";
import { withTenantContext } from "../client.js";
import { auditLog } from "../schema/audit-log.js";
import { events } from "../schema/events.js";
import { sensorDevices } from "../schema/sensor-devices.js";

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
