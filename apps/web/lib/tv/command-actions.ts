"use server";

import { enqueueTvCommand } from "@kimiterrace/db";
import { revalidatePath } from "next/cache";
import { requireRole } from "../auth/guard";
import { withSession } from "../db";
import {
  type ActionResult,
  type TvCommandActor,
  forbidden,
  invalid,
  isTvCommandType,
  isUuid,
  notFound,
  toTvCommandActor,
} from "./command-core";
import { TV_CONFIG_EDIT_ROLES } from "./config-edit-core";

/**
 * F15 §4.2 (ADR-022 / ADR-008 — 画面 mutation は Server Actions): TV リモートコマンド発行の Server Action。
 *
 * 操作: 入力検証 → 認可 (`requireRole(TV_CONFIG_EDIT_ROLES)`) → actor 解決 → `withSession` の自校 RLS tx
 * 内で **対象 device を RLS スコープで解決 + pending コマンド 1 件 INSERT + audit_log 追記**（query 層
 * `enqueueTvCommand` が原子的に）→ `revalidatePath`。`tv_device_commands` は手書き WHERE school_id を持たず
 * RLS (`tenant_isolation`) が自校を強制する（ルール2）。他校 / 不可視 / 退役 TV は `device_not_found`
 * → `not_found` に写像する。
 *
 * **認可境界（ルール2 多層防御）**: コマンド発行は **書き込み**のため設定編集と同じ `TV_CONFIG_EDIT_ROLES`
 * (school_admin / system_admin) に絞る（teacher は閲覧のみ → 403）。
 *
 * **system_admin の降格 (ADR-019 §#95 / Issue #226)**: 特定デバイス = 特定 school のテナントスコープ操作の
 * ため `withSession(..., { tenantScoped: true })` で実行する。tenantScoped で system_admin を school_admin に
 * 降格すると `system_admin_full_access` policy の全校発火が止まり、他校デバイスへの cross-tenant 発行を
 * DB レベルで封じる（config-edit-actions.ts と同方針）。schoolId 無しの system_admin は toTvCommandActor が
 * null → forbidden。
 *
 * **監査（ルール1 / NFR04）**: コマンド発行は `audit_log` に 1 件残す（誰がいつどの TV に何を、F15 §1/§5）。
 *
 * **PII 非格納（ルール4）**: コマンドに個人情報を載せない（本 Action は引数なしの定型コマンドのみ受ける）。
 */

/** 認可 + actor 解決。teacher / テナント未選択は forbidden。 */
async function authorize(): Promise<TvCommandActor | ActionResult<never>> {
  const user = await requireRole(TV_CONFIG_EDIT_ROLES);
  const actor = toTvCommandActor(user);
  if (!actor) {
    return forbidden("学校に属さないユーザーは TV コマンドを発行できません。");
  }
  return actor;
}

/**
 * 指定 TV デバイスへリモートコマンドを発行する（pending を 1 件キューイング）。
 *
 * @param rawDeviceRowId 対象 `tv_devices.id`（device_id ではなく行 PK）
 * @param rawCommand     コマンド種別（signage_reload / signage_open / signage_exit / service_restart）
 */
export async function enqueueTvCommandAction(
  rawDeviceRowId: unknown,
  rawCommand: unknown,
): Promise<ActionResult<{ id: string }>> {
  if (!isUuid(rawDeviceRowId)) {
    return invalid("デバイスの指定が不正です。");
  }
  if (!isTvCommandType(rawCommand)) {
    return invalid("コマンドの種別が不正です。");
  }
  const id = rawDeviceRowId;
  const command = rawCommand;

  const actor = await authorize();
  if ("ok" in actor) {
    return actor;
  }

  // tenantScoped: system_admin を school_admin に降格し full_access policy の全校発火を止める
  // (ADR-019 §#95 / Issue #226)。本 Action は特定デバイス = 特定 school のテナントスコープ操作。
  const result = await withSession(
    (tx) =>
      enqueueTvCommand(tx, {
        deviceRowId: id,
        command,
        actorUserId: actor.userId,
        actorSchoolId: actor.schoolId,
      }),
    { tenantScoped: true },
  );

  if (result.status === "device_not_found") {
    return notFound("対象の TV デバイスが見つかりません。");
  }

  revalidatePath(`/admin/tv-devices/${id}/edit`);
  return { ok: true, data: { id: result.id } };
}
