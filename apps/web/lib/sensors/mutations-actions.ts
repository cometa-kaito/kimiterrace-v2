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
 * 各操作: 入力検証 → 認可 (`requireRole(SENSOR_WRITE_ROLES)` = school_admin / system_admin、teacher は 403) →
 * actor 解決 → `withSession` の**対象校** RLS tx 内で mutation + `audit_log` 追記 (ルール1/NFR04) →
 * `revalidatePath`。`SET LOCAL` は手書きせず `withSession` に委譲 (ADR-019 / ADR-008)。
 *
 * **system_admin の特定校代行 (ADR-041 D3、ads-actions.ts と同型)**: 各 action は末尾に任意の
 * `targetSchoolId` を取り、`toSensorActor(user, targetSchoolId)` で actor を解決する。school_admin は
 * `targetSchoolId` を無視して自校固定 (越境不可)、system_admin は対象校を actor.schoolId にする。
 * tx は `withSession(..., { tenantScoped: true, schoolId: actor.schoolId })` で張り、system_admin を
 * school_admin に**降格**して `system_admin_full_access` policy の全校発火を止める。これが無いと
 * schoolId claim を持つ system_admin の `classBelongsToTenant` が他校クラスを可視と判定し、別テナントの
 * class_id を参照する「ねじれ行」を作れてしまう (cross-tenant write)。降格後は `tenant_isolation` の
 * WITH CHECK + class 可視性チェックで DB レベルに不成立。
 *
 * **テナント境界は RLS が DB レベルで強制 (ルール2、手書き WHERE school_id を書かない)**:
 *  - register: `school_id` は actor の (自校 or 対象校) id を入れ、`tenant_isolation` の WITH CHECK が
 *    一致を強制 (他校 id は INSERT 拒否)。`class_id` は school_id と独立 FK のため、結線前に
 *    `classBelongsToTenant` で**スコープ校に可視か RLS 経由で確認**し、ねじれ行を防ぐ (magic-links と同方針)。
 *  - edit: 対象は RLS の tenant_isolation で対象校行のみ可視 = 更新可。他校/不可視 id は 0 行 UPDATE →
 *    not_found 写像。class_id を変える場合も `classBelongsToTenant` で確認する。
 *
 * **監査 actor の三系統 (ルール1 / system_admin は users 表に行を持たない)**: `created_by`/`updated_by` は
 * `actor.userRef` (system_admin は null = FK 回避)、`audit_log` は actor_user_id=acting uid /
 * actor_identity_uid=IdP uid (system_admin のみ) / created_by=updated_by=userRef で記録する。
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
    actorUserId: actor.actorUserId,
    actorIdentityUid: actor.identityUid,
    schoolId: actor.schoolId,
    tableName: "sensor_devices",
    recordId: params.recordId,
    operation: params.operation,
    diff: params.diff as object,
    rowHash: "",
    createdBy: actor.userRef,
    updatedBy: actor.userRef,
  });
}

/**
 * 認可 + actor 解決。teacher / テナント未選択は forbidden。`targetSchoolId` は **system_admin が特定校を
 * 対象にする経路** (/ops/schools/[id]/sensors) からのみ意味を持つ。tenant ロール (school_admin) では
 * `toSensorActor` が無視し自校に固定する (越境防止)。system_admin で対象校未指定 / 不正なら forbidden。
 */
async function authorize(targetSchoolId?: string): Promise<SensorActor | ActionResult<never>> {
  const user = await requireRole(SENSOR_WRITE_ROLES);
  const actor = toSensorActor(user, targetSchoolId);
  if (!actor) {
    return forbidden(
      user.role === "system_admin"
        ? "対象の学校が指定されていません。"
        : "学校に属さないユーザーはセンサーを操作できません。",
    );
  }
  return actor;
}

/**
 * mutation の共通後処理: 対象校 tx 実行 → 一覧 revalidate → 統一エラー写像。
 *
 * `schoolId`: school_admin は自校 (= 渡しても同値)、system_admin は対象校 (/ops 経路)。`withSession` 側で
 * 「system_admin のときだけ override を honor」するため tenant ロールは自校に固定される (越境防止)。
 * `tenantScoped: true` で system_admin を school_admin に降格し `system_admin_full_access` の全校発火を止める。
 */
async function finish<T>(
  build: (tx: TenantTx) => Promise<T>,
  schoolId: string,
): Promise<ActionResult<T>> {
  try {
    const data = await withSession(build, { tenantScoped: true, schoolId });
    revalidatePath("/ops/sensors");
    // system_admin の /ops 経路 (対象校センサー一覧) も即時反映。school_admin の自校経路では未使用だが無害。
    revalidatePath(`/ops/schools/${schoolId}/sensors`);
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
 * スコープ校 (自校 or system_admin の対象校) にセンサーを 1 台登録する。
 * device_mac は正規化して保存、class_id 指定時は可視性を確認、グローバル一意衝突は conflict。
 */
export async function createSensorDeviceAction(
  raw: {
    deviceMac?: unknown;
    locationLabel?: unknown;
    classId?: unknown;
  },
  targetSchoolId?: string,
): Promise<ActionResult<{ id: string }>> {
  const v = validateCreateSensorInput(raw ?? {});
  if (!v.ok) {
    return invalid(v.message);
  }
  const actor = await authorize(targetSchoolId);
  if ("ok" in actor) {
    return actor;
  }

  return finish(async (tx) => {
    // class_id 指定時はスコープ校で可視か (他校 id は RLS で不可視 → CrossTenantClassError)。
    if (v.value.classId !== null && !(await classBelongsToTenant(tx, v.value.classId))) {
      throw new CrossTenantClassError("指定されたクラスが見つかりません。");
    }
    const { id } = await createSensorDevice(tx, {
      schoolId: actor.schoolId,
      deviceMac: v.value.deviceMac,
      locationLabel: v.value.locationLabel,
      classId: v.value.classId,
      // created_by/updated_by は users FK (0014)。system_admin は users 行が無いため null (FK 回避)。
      actorUserId: actor.userRef,
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
  }, actor.schoolId);
}

/**
 * スコープ校 (自校 or system_admin の対象校) センサー 1 台の編集可能フィールド (location_label / class_id)
 * を更新する。他校/不可視デバイスは 0 行 UPDATE → not_found。class_id 変更時は可視性を確認。
 */
export async function updateSensorDeviceAction(
  rawSensorId: unknown,
  raw: { locationLabel?: unknown; classId?: unknown },
  targetSchoolId?: string,
): Promise<ActionResult<{ id: string }>> {
  if (!isUuid(rawSensorId)) {
    return invalid("センサーの指定が不正です。");
  }
  const sensorId = rawSensorId;
  const v = validateUpdateSensorInput(raw ?? {});
  if (!v.ok) {
    return invalid(v.message);
  }
  const actor = await authorize(targetSchoolId);
  if ("ok" in actor) {
    return actor;
  }

  try {
    const result = await withSession(
      async (tx): Promise<UpdateSensorDeviceResult> => {
        // before スナップショット (スコープ校で可視のみ取得。他校/不可視は null = 後段 0 行 UPDATE と整合)。
        const before = await getOwnSensorDevice(tx, sensorId);
        // class_id を付ける場合はスコープ校で可視か確認 (他校クラスへの「ねじれ結線」防止)。
        if (v.value.classId !== null && !(await classBelongsToTenant(tx, v.value.classId))) {
          throw new CrossTenantClassError("指定されたクラスが見つかりません。");
        }
        // updated_by は users FK。system_admin は users 行が無いため null (FK 回避)。
        const updated = await updateSensorDevice(tx, sensorId, v.value, actor.userRef);
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
      },
      // tenantScoped 降格 + 対象校 override (system_admin のみ honor)。ads-actions.ts と同型。
      { tenantScoped: true, schoolId: actor.schoolId },
    );
    if (!result.updated) {
      return notFound("センサーが見つかりません。");
    }
    revalidatePath("/ops/sensors");
    revalidatePath(`/ops/schools/${actor.schoolId}/sensors`);
    return { ok: true, data: { id: result.id } };
  } catch (error) {
    if (error instanceof CrossTenantClassError) {
      return invalid(error.message);
    }
    throw error;
  }
}
