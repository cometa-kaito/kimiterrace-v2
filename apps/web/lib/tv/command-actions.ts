"use server";

import { enqueueTvCommand } from "@kimiterrace/db";
import { revalidatePath } from "next/cache";
import { requireRole } from "../auth/guard";
import { withSession } from "../db";
import {
  type ActionResult,
  type TvCommandActor,
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
 * 操作: 入力検証 → 認可 (`requireRole(TV_CONFIG_EDIT_ROLES)`) → actor 解決 → `withSession` の RLS tx
 * 内で **対象 device を RLS スコープで解決 + pending コマンド 1 件 INSERT + audit_log 追記**（query 層
 * `enqueueTvCommand` が原子的に）→ `revalidatePath`。`tv_device_commands` は手書き WHERE school_id を持たず
 * RLS が可視範囲を強制する（ルール2）: school_admin=自校 (`tenant_isolation`) / system_admin=全校
 * (`system_admin_full_access`)。他校 / 不可視 / 退役 TV は `device_not_found` → `not_found` に写像する。
 *
 * **認可境界（ルール2 多層防御）**: コマンド発行は **書き込み**のため設定編集と同じ `TV_CONFIG_EDIT_ROLES`
 * (school_admin / system_admin) に絞る（teacher は閲覧のみ → 403）。
 *
 * **認可と cross-tenant（ADR-019 / config-edit-actions.ts・onboarding-actions と同方針）**: school_admin は
 * 自校デバイスのみ（RLS `tenant_isolation`）、system_admin は全校デバイスへ発行できる（RLS
 * `system_admin_full_access`、cross-tenant 運用者）。`withSession` は `tenantScoped` を **使わない**（降格すると
 * system_admin が full_access を失い、users 行でない system_admin actor で監査の actor 制約に矛盾する）。
 * コマンドは引数なしの定型で対象は行 PK 1 件のため cross-tenant な子参照付け替え (Issue #226) は起きない。
 * **旧実装は schoolId 無しの system_admin を forbidden にしていたが、設定編集と同じく cross-tenant 運用者を
 * 不能にするバグであり本 Action でも解消する。** 監査 actor は system_admin だと users FK 列 null +
 * actor_identity_uid に IdP uid（onboarding-actions と同パターン、enqueueTvCommand 側で処理）。
 *
 * **監査（ルール1 / NFR04）**: コマンド発行は `audit_log` に 1 件残す（誰がいつどの TV に何を、F15 §1/§5）。
 *
 * **PII 非格納（ルール4）**: コマンドに個人情報を載せない（本 Action は引数なしの定型コマンドのみ受ける）。
 */

/**
 * 認可 + actor 解決。teacher は `requireRole` が /forbidden へ（role 境界の第一層）。残る school_admin /
 * system_admin はどちらも発行できる（後者は school 未所属でも cross-tenant 運用者として可、`toTvCommandActor`
 * が null を返さない＝旧「テナント未選択 system_admin は forbidden」を解消）。
 */
async function authorize(): Promise<TvCommandActor> {
  const user = await requireRole(TV_CONFIG_EDIT_ROLES);
  return toTvCommandActor(user);
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

  // tenantScoped は使わない: school_admin は tenant_isolation で自校に限定され、system_admin は full_access で
  // 全校に発行できる（cross-tenant 運用者、onboarding と同じ経路）。allowedRoles で role 境界を tx 層でも
  // 二重化する（多層防御、ルール2）。actor.userId は system_admin だと null（users 行でない）。
  const result = await withSession(
    (tx) =>
      enqueueTvCommand(tx, {
        deviceRowId: id,
        command,
        actorUserId: actor.userId,
        actorIdentityUid: actor.identityUid,
      }),
    { allowedRoles: TV_CONFIG_EDIT_ROLES },
  );

  if (result.status === "device_not_found") {
    return notFound("対象の TV デバイスが見つかりません。");
  }

  revalidatePath(`/admin/tv-devices/${id}/edit`);
  return { ok: true, data: { id: result.id } };
}
