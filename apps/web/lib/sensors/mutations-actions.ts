"use server";

import {
  type TenantTx,
  type UpdateSensorDeviceResult,
  auditLog,
  classBelongsToTenant,
  createSensorDevice,
  getOwnSensorDevice,
  updateSensorDevice,
} from "@kimiterrace/db";
import { revalidatePath } from "next/cache";
import { requireRole } from "../auth/guard";
import { withSession } from "../db";
import {
  SENSOR_WRITE_ROLES,
  type ActionResult,
  type SensorActor,
  conflict,
  forbidden,
  invalid,
  isUuid,
  notFound,
  toSensorActor,
  validateCreateSensorInput,
  validateUpdateSensorInput,
} from "./mutations-core";

/**
 * F13 (#391, ADR-020): 来場検知センサーの **登録 / 編集** Server Actions。
 *
 * 各操作: 入力検証 → 認可 (`requireRole(SENSOR_WRITE_ROLES)` = school_admin のみ、teacher は 403) →
 * actor 解決 → `withSession` の自校 RLS tx 内で mutation + `audit_log` 追記 (ルール1/NFR04) →
 * `revalidatePath`。`SET LOCAL` は手書きせず `withSession` に委譲 (ADR-019 / ADR-008)。
 *
 * **テナント境界は RLS が DB レベルで強制 (ルール2、手書き WHERE school_id を書かない)**:
 *  - register: `school_id` は actor の自校 id を入れ、`tenant_isolation` の WITH CHECK が一致を強制
 *    (他校 id は INSERT 拒否)。`class_id` は school_id と独立 FK のため、結線前に `classBelongsToTenant`
 *    で**自校可視か RLS 経由で確認**し、他校クラスへぶら下げる「ねじれ行」を防ぐ (magic-links と同方針)。
 *  - edit: 対象は RLS の tenant_isolation で自校行のみ可視 = 更新可。他校/不可視 id は 0 行 UPDATE →
 *    not_found 写像。class_id を変える場合も `classBelongsToTenant` で自校確認する。
 *
 * **device_mac グローバル一意衝突 (#408/#410)**: 既登録 MAC (自校 or **他校**) の register は SQLSTATE 23505。
 * conflict として返し、**他校の行 (どの学校が使用中か等) は一切返さない** (テナント越境情報の非開示)。
 *
 * **撤去 (retire)**: `decommissioned_at` 列は既存スキーマにあるため新規列は不要だが、本 mutation スライスは
 * register + edit に絞る。撤去 UI/Action は後続フォロー (本 PR では出さない)。
 */

/** 親参照 (class) が自校で不可視のとき tx をロールバックさせる内部エラー (cross-tenant 防止)。 */
class CrossTenantClassError extends Error {}

/** PostgreSQL の unique 制約違反 (SQLSTATE 23505)。device_mac グローバル一意衝突など。 */
function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  return (error as { code: unknown }).code === "23505";
}

/** audit_log に 1 行追記 (ルール1 / NFR04)。prev_hash/row_hash は BEFORE INSERT トリガが計算。 */
async function writeAudit(
  tx: TenantTx,
  actor: SensorActor,
  params: {
    recordId: string;
    operation: "insert" | "update";
    diff: unknown;
  },
): Promise<void> {
  await tx.insert(auditLog).values({
    actorUserId: actor.userId,
    schoolId: actor.schoolId,
    tableName: "sensor_devices",
    recordId: params.recordId,
    operation: params.operation,
    diff: params.diff as object,
    rowHash: "",
    createdBy: actor.userId,
    updatedBy: actor.userId,
  });
}

/** 認可 + actor 解決。teacher / テナント未選択は forbidden。 */
async function authorize(): Promise<SensorActor | ActionResult<never>> {
  const user = await requireRole(SENSOR_WRITE_ROLES);
  const actor = toSensorActor(user);
  if (!actor) {
    return forbidden("学校に属さないユーザーはセンサーを操作できません。");
  }
  return actor;
}

/** mutation の共通後処理: 自校 tx 実行 → 一覧 revalidate → 統一エラー写像。 */
async function finish<T>(build: (tx: TenantTx) => Promise<T>): Promise<ActionResult<T>> {
  try {
    const data = await withSession(build);
    revalidatePath("/app/sensors");
    return { ok: true, data };
  } catch (error) {
    if (error instanceof CrossTenantClassError) {
      return invalid(error.message);
    }
    if (isUniqueViolation(error)) {
      // 他校で登録済みの MAC でも、どの学校かは開示しない (テナント越境情報の非開示)。
      return conflict(
        "この MAC アドレスは既に登録されています。別のセンサーで使用されていないか確認してください。",
      );
    }
    throw error;
  }
}

/**
 * 自校にセンサーを 1 台登録する。
 * device_mac は正規化して保存、class_id 指定時は自校可視性を確認、グローバル一意衝突は conflict。
 */
export async function createSensorDeviceAction(raw: {
  deviceMac?: unknown;
  locationLabel?: unknown;
  classId?: unknown;
}): Promise<ActionResult<{ id: string }>> {
  const v = validateCreateSensorInput(raw ?? {});
  if (!v.ok) {
    return invalid(v.message);
  }
  const actor = await authorize();
  if ("ok" in actor) {
    return actor;
  }

  return finish(async (tx) => {
    // class_id 指定時は自校で可視か (他校 id は RLS で不可視 → CrossTenantClassError)。
    if (v.value.classId !== null && !(await classBelongsToTenant(tx, v.value.classId))) {
      throw new CrossTenantClassError("指定されたクラスが見つかりません。");
    }
    const { id } = await createSensorDevice(tx, {
      schoolId: actor.schoolId,
      deviceMac: v.value.deviceMac,
      locationLabel: v.value.locationLabel,
      classId: v.value.classId,
      actorUserId: actor.userId,
    });
    await writeAudit(tx, actor, {
      recordId: id,
      operation: "insert",
      diff: {
        after: {
          // device_mac は擬似識別子。監査 diff には末尾 4 桁のみ残す (F13 §4、丸出ししない)。
          deviceMacSuffix: v.value.deviceMac.slice(-4),
          hasLocationLabel: v.value.locationLabel !== null,
          hasClass: v.value.classId !== null,
        },
      },
    });
    return { id };
  });
}

/**
 * 自校センサー 1 台の編集可能フィールド (location_label / class_id) を更新する。
 * 他校/不可視デバイスは 0 行 UPDATE → not_found。class_id 変更時は自校可視性を確認。
 */
export async function updateSensorDeviceAction(
  rawSensorId: unknown,
  raw: { locationLabel?: unknown; classId?: unknown },
): Promise<ActionResult<{ id: string }>> {
  if (!isUuid(rawSensorId)) {
    return invalid("センサーの指定が不正です。");
  }
  const sensorId = rawSensorId;
  const v = validateUpdateSensorInput(raw ?? {});
  if (!v.ok) {
    return invalid(v.message);
  }
  const actor = await authorize();
  if ("ok" in actor) {
    return actor;
  }

  try {
    const result = await withSession(async (tx): Promise<UpdateSensorDeviceResult> => {
      // before スナップショット (自校可視のみ取得。他校/不可視は null = 後段 0 行 UPDATE と整合)。
      const before = await getOwnSensorDevice(tx, sensorId);
      // class_id を付ける場合は自校で可視か確認 (他校クラスへの「ねじれ結線」防止)。
      if (v.value.classId !== null && !(await classBelongsToTenant(tx, v.value.classId))) {
        throw new CrossTenantClassError("指定されたクラスが見つかりません。");
      }
      const updated = await updateSensorDevice(tx, sensorId, v.value, actor.userId);
      if (updated.updated) {
        await writeAudit(tx, actor, {
          recordId: sensorId,
          operation: "update",
          diff: {
            before: {
              hasLocationLabel: before?.locationLabel != null,
              hasClass: before?.classId != null,
            },
            after: {
              hasLocationLabel: v.value.locationLabel !== null,
              hasClass: v.value.classId !== null,
            },
          },
        });
      }
      return updated;
    });
    if (!result.updated) {
      return notFound("センサーが見つかりません。");
    }
    revalidatePath("/app/sensors");
    return { ok: true, data: { id: result.id } };
  } catch (error) {
    if (error instanceof CrossTenantClassError) {
      return invalid(error.message);
    }
    throw error;
  }
}
