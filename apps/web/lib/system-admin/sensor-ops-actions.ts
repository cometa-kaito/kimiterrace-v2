"use server";

import {
  type TenantTx,
  auditLog,
  getOwnSensorDevice,
  setSensorDecommissioned,
} from "@kimiterrace/db";
import { revalidatePath } from "next/cache";
import { requireRole } from "../auth/guard";
import { withSession } from "../db";
import { SYSTEM_ADMIN_ROLES } from "./roles";
import { type ActionResult, invalid, isUuid, notFound } from "./schools-core";

/**
 * 運営整理 §4 item5: 全校 (system_admin) センサー運用 Server Action — **撤去 / 再稼働**。
 *
 * `/ops/sensors` (全校横断ビュー) から運営が任意校のセンサーを撤去 (decommission) / 再稼働できるようにする。
 * 既存の登録 / 編集 (`lib/sensors/mutations-actions.ts`) は **school_admin の自校スコープ** (actor の自校 id +
 * `tenant_isolation` WITH CHECK) なのに対し、本アクションは **system_admin の全校横断** = 別経路:
 *  - 認可: `requireRole(SYSTEM_ADMIN_ROLES)` (school_admin / teacher は 403)。
 *  - RLS (ルール2): `withSession` の system_admin context で `system_admin_full_access` が全校 UPDATE を grant。
 *    手書き WHERE school_id は書かない。他校/不可視/不存在 id は 0 行 UPDATE → `not_found`。
 *  - 監査 (ルール1): system_admin は `users` 行ではないため `actor_user_id` / `created_by` / `updated_by` は
 *    FK 制約で NULL とし、FK の無い `actor_identity_uid` に IdP uid を載せて「誰が」を立証可能にする
 *    (schools/advertisers の system_admin パターンと同型)。`school_id` には**対象センサーの所属校 id** を
 *    記録する (0005 policy が system_admin context の任意 school_id を許可、追跡用)。
 *
 * 撤去は物理 DELETE せず `decommissioned_at` を設定する論理状態 — 過去の検知履歴・監査は保全され、再稼働で戻せる。
 */

/** 対象センサーが RLS で不可視 (他校 / 不存在) / 0 行更新のとき tx をロールバックさせる。 */
class SensorNotFoundError extends Error {}

/**
 * センサー 1 件の撤去 (`decommissioned=true`) / 再稼働 (`false`) を切り替える。
 * 認可・RLS・監査は上記 docstring 参照。`decommissioned` の boolean で論理状態を反転する。
 */
export async function setSensorDecommissionedAction(raw: {
  id?: unknown;
  decommissioned?: unknown;
}): Promise<ActionResult<{ id: string; decommissioned: boolean }>> {
  if (!isUuid(raw.id)) {
    return invalid("センサーの指定が不正です。");
  }
  if (typeof raw.decommissioned !== "boolean") {
    return invalid("状態の指定が不正です。");
  }
  const id = raw.id;
  const decommissioned = raw.decommissioned;
  await requireRole(SYSTEM_ADMIN_ROLES);

  try {
    const data = await withSession(async (tx: TenantTx, user) => {
      // before スナップショット (兼 not_found 検出 + 監査用の所属校 id 取得)。system_admin context では全校可視。
      const before = await getOwnSensorDevice(tx, id);
      if (!before) {
        throw new SensorNotFoundError();
      }
      // system_admin は users 行ではないため actor 系は FK 制約で null。
      const actorRef = user.role === "system_admin" ? null : user.uid;
      const result = await setSensorDecommissioned(
        tx,
        id,
        decommissioned ? new Date() : null,
        actorRef,
      );
      if (!result.updated) {
        // 多層防御: SELECT が通って UPDATE が 0 行 = RLS 越境 (本来到達しない)。
        throw new SensorNotFoundError();
      }
      await tx.insert(auditLog).values({
        actorUserId: actorRef,
        actorIdentityUid: user.uid,
        // 追跡用に対象センサーの所属校 id を記録 (system_admin context で任意 school_id 許可、0005 policy)。
        schoolId: before.schoolId,
        tableName: "sensor_devices",
        recordId: id,
        operation: "update",
        // 撤去状態の前後のみ記録 (device_mac 等の擬似識別子は出さない、F13 §4)。
        diff: {
          before: { decommissioned: before.decommissionedAt != null },
          after: { decommissioned },
        },
        rowHash: "",
        createdBy: actorRef,
        updatedBy: actorRef,
      });
      return { id, decommissioned };
    });
    revalidatePath("/ops/sensors");
    return { ok: true, data };
  } catch (error) {
    if (error instanceof SensorNotFoundError) {
      return notFound("センサーが見つかりません。");
    }
    throw error;
  }
}
