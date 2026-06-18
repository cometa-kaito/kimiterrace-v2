"use server";

import { type TenantTx, auditLog, softDeleteTvDevice, updateTvDeviceConfig } from "@kimiterrace/db";
import { revalidatePath } from "next/cache";
import { requireRole } from "../auth/guard";
import { withSession } from "../db";
import { isPgErrorCode } from "../pg-error";
import {
  type ActionResult,
  type TvConfigEditActor,
  type TvConfigEditInput,
  type TvConfigEditPatch,
  TV_CONFIG_EDIT_ROLES,
  conflict,
  invalid,
  isUuid,
  notFound,
  toTvConfigEditActor,
  validateTvConfigEdit,
} from "./config-edit-core";

/**
 * F15 §4.2 (ADR-022 / ADR-008 — 画面 mutation は Server Actions): TV デバイス設定編集の Server Action。
 *
 * 操作: 入力検証 → 認可 (`requireRole(TV_CONFIG_EDIT_ROLES)`) → actor 解決 → `withSession` の RLS tx
 * 内で **オペレーター編集可能フィールドのみ UPDATE + version +1（ADR-022）** + `audit_log` 追記 →
 * `revalidatePath`。`tv_devices` は手書き WHERE school_id を持たず、RLS が可視範囲を強制する（ルール2）:
 * school_admin=自校 (`tenant_isolation`) / system_admin=全校 (`system_admin_full_access`)。0 行（他校 /
 * 不可視 / 退役 TV）は `not_found` に写像する。
 *
 * **version バンプ（ADR-022）**: TV は応答 `version` の差分でのみ設定を反映する。設定変更時に version を
 * 上げないと TV が変更を検知できないため、`updateTvDeviceConfig` が同一 UPDATE で `version+1` する。
 *
 * **監査（ルール1 / NFR04）**: 設定変更は `audit_log` に 1 件残す（誰がいつ何を変更したか）。`updated_at`
 * は query 層が明示的に進める（[[updatedat-explicit-on-update]]）。心拍 touch（pollTvConfig）とは別経路。
 *
 * **認可と cross-tenant（ADR-019 / 新規登録 onboarding-actions と同方針）**: school_admin は自校デバイスのみ
 * （RLS `tenant_isolation`）、system_admin は全校デバイスを編集できる（RLS `system_admin_full_access`、
 * 全テナント横断の運用者）。後者は新規登録 (`createTvDeviceAction`) と同じ cross-tenant 経路で、`withSession`
 * は `tenantScoped` を **使わない**（降格すると system_admin が full_access を失い、かつ users 行でない
 * system_admin の actor で監査の actor 制約に矛盾する）。`tv_devices` の編集パッチは school_id 等の FK を
 * 一切持たず（下記「システム管理列の遮断」）、対象は行 PK 1 件なので、ハブ/広告のような cross-tenant な
 * 子参照付け替え (Issue #226 で降格が防ぐ越権) は構造的に発生しない。**旧実装は schoolId 無しの system_admin
 * を forbidden にしていたが、これは「登録はできるが設定編集はできない」非対称＝バグであり、本 Action で解消する。**
 *
 * **監査 actor（ルール1 / NFR04, onboarding-actions と同パターン）**: system_admin は `users` 行でなく
 * `system_admins` 行のため、users(id) FK を持つ `tv_devices.updated_by` / `audit_log.actor_user_id` 等に uid を
 * 入れられない → FK 列は **null**、「誰が」は FK 無しの `actor_identity_uid` に IdP uid を残す。audit の school_id
 * は更新対象デバイスの school（actor 由来でなくデバイス由来）を記録する。
 *
 * **システム管理列の遮断**: `validateTvConfigEdit` は編集可能フィールドのみ受け取り、`device_id` /
 * `school_id` / `version` / `last_seen_at` / `alert_state` 等は型レベルで入ってこない（クライアント自由入力
 * からの混入も DB へ漏れない）。
 */

/** PostgreSQL の unique / check 制約違反 (SQLSTATE 23505 / 23514)。並行更新や制約違反など。 */
function isConstraintViolation(error: unknown): boolean {
  return isPgErrorCode(error, "23505", "23514");
}

/**
 * audit_log に 1 行追記 (ルール1 / NFR04)。prev_hash/row_hash は BEFORE INSERT トリガが計算。
 *
 * `schoolId` は更新対象デバイスの school（呼出側が UPDATE の RETURNING から渡す）。FK 列
 * （actor_user_id / created_by / updated_by）は system_admin だと null、「誰が」は FK 無しの
 * actor_identity_uid に IdP uid を残す（audit_log_insert policy: role=system_admin は actor=null / 任意
 * school 許可、テナントロールは actor=自分の user_id 完全一致、migration 0005）。
 */
async function writeAudit(
  tx: TenantTx,
  actor: TvConfigEditActor,
  params: { recordId: string; schoolId: string; operation: "update" | "delete"; diff: unknown },
): Promise<void> {
  await tx.insert(auditLog).values({
    actorUserId: actor.userId,
    actorIdentityUid: actor.identityUid,
    schoolId: params.schoolId,
    tableName: "tv_devices",
    recordId: params.recordId,
    operation: params.operation,
    diff: params.diff as object,
    rowHash: "",
    createdBy: actor.userId,
    updatedBy: actor.userId,
  });
}

/**
 * 認可 + actor 解決。teacher は `requireRole` が /forbidden へ（role 境界の第一層）。残る
 * school_admin / system_admin はどちらも編集できる（後者は school 未所属でも cross-tenant 運用者として
 * 可、`toTvConfigEditActor` が null を返さない＝旧「テナント未選択 system_admin は forbidden」を解消）。
 */
async function authorize(): Promise<TvConfigEditActor> {
  const user = await requireRole(TV_CONFIG_EDIT_ROLES);
  return toTvConfigEditActor(user);
}

/** 監査 diff: 設定の各フィールド（PII は含まない設置情報）と version 遷移を要約して残す。 */
function auditView(patch: TvConfigEditPatch, newVersion: number): Record<string, unknown> {
  return { after: patch, version: newVersion };
}

/**
 * 指定 TV デバイスの設定を更新する（version +1）。
 *
 * @param rawDeviceRowId 対象 `tv_devices.id`（device_id ではなく行 PK）
 * @param rawInput       編集フォーム入力（編集可能フィールドのみ）
 */
export async function updateTvDeviceConfigAction(
  rawDeviceRowId: unknown,
  rawInput: TvConfigEditInput,
): Promise<ActionResult<{ id: string; version: number }>> {
  if (!isUuid(rawDeviceRowId)) {
    return invalid("デバイスの指定が不正です。");
  }
  const id = rawDeviceRowId;
  const v = validateTvConfigEdit(rawInput);
  if (!v.ok) {
    return invalid(v.message);
  }
  const actor = await authorize();

  try {
    // ⚠️ SSRF: ここで保存する `patch.signageUrl` / `patch.webhookUrl` は将来も**サーバ側で fetch しない**
    // こと（現状シンク無し＝ADR-022 で TV 端末がクライアント側で叩く）。死活確認・プレビュー・画面
    // キャプチャ等でサーバ側 fetch を追加する場合は、保存時の `checkEditableUrl`（config-edit-core.ts）
    // 検証に依存せず、**fetch 時に解決済み IP を `isBlockedInternalHost` で再検証**すること
    // （DNS-rebinding 対策。公開ホスト名が解決時に 169.254.169.254 等の内部 IP へ化けうる）。
    // tenantScoped は使わない: school_admin は tenant_isolation で自校に限定され、system_admin は
    // full_access で全校編集できる（cross-tenant 運用者、onboarding と同じ経路）。allowedRoles で role 境界を
    // tx 層でも二重化する（多層防御、ルール2）。
    const updated = await withSession(
      async (tx) => {
        const ref = await updateTvDeviceConfig(tx, {
          id,
          patch: v.value,
          actorUserId: actor.userId,
        });
        if (!ref) {
          // 0 行: 他校 / 不可視 / 退役 TV（RLS で弾かれた or deleted_at）。null を返し外で not_found。
          return null;
        }
        await writeAudit(tx, actor, {
          recordId: ref.id,
          schoolId: ref.schoolId,
          operation: "update",
          diff: auditView(v.value, ref.version),
        });
        return ref;
      },
      { allowedRoles: TV_CONFIG_EDIT_ROLES },
    );

    if (!updated) {
      return notFound("対象の TV デバイスが見つかりません。");
    }

    revalidatePath("/ops/tv-devices");
    revalidatePath(`/ops/tv-devices/${id}/edit`);
    return { ok: true, data: { id: updated.id, version: updated.version } };
  } catch (error) {
    if (isConstraintViolation(error)) {
      return conflict("他の操作と競合しました。最新の内容を読み込み直してください。");
    }
    throw error;
  }
}

/** 監査 diff（削除）: 撤去したデバイスの識別情報（設置ラベル / device_id・PII 非含）を before-snapshot で残す。 */
function deleteAuditView(ref: { deviceId: string; label: string | null }): Record<string, unknown> {
  return { before: { deviceId: ref.deviceId, label: ref.label }, deleted: true };
}

/**
 * F15 §4.2: 指定 TV デバイスを**ソフトデリート（退役）**する Server Action。
 *
 * 操作: 行 id 検証 → 認可（`requireRole(TV_CONFIG_EDIT_ROLES)`）→ actor 解決 → `withSession` の RLS tx 内で
 * `softDeleteTvDevice`（`deleted_at` を now() に設定）+ `audit_log`（operation=delete）追記 → `revalidatePath`。
 *
 * **認可と cross-tenant（updateTvDeviceConfigAction と同方針）**: school_admin は自校デバイスのみ
 * （RLS `tenant_isolation`）、system_admin は全校デバイスを削除できる（`system_admin_full_access`、cross-tenant
 * 運用者）。`tenantScoped` は使わず `allowedRoles` で role 境界を tx 層でも二重化する（多層防御、ルール2）。
 * 0 行（他校 / 不可視 / **既に削除済み**）は `not_found` に写像する（冪等＝二重削除は安全に no-op）。
 *
 * **ソフトデリート（hard でない）理由**: 過去の死活/設定履歴・子参照 FK（commands / downtime）を保全しつつ、
 * `device_id` の部分 UNIQUE（migration 0027, `WHERE deleted_at IS NULL`）により**同じ物理端末での再登録を許す**。
 *
 * **監査 actor（ルール1）**: system_admin は `users` 行でないため FK 列（`updated_by` / `actor_user_id`）は null、
 * 「誰が」は `actor_identity_uid` に IdP uid を残す。audit の school_id は削除対象デバイスの school（RETURNING 由来）。
 *
 * @param rawDeviceRowId 対象 `tv_devices.id`（device_id ではなく行 PK）。
 */
export async function deleteTvDeviceAction(
  rawDeviceRowId: unknown,
): Promise<ActionResult<{ id: string }>> {
  if (!isUuid(rawDeviceRowId)) {
    return invalid("デバイスの指定が不正です。");
  }
  const id = rawDeviceRowId;
  const actor = await authorize();

  const deleted = await withSession(
    async (tx) => {
      const ref = await softDeleteTvDevice(tx, { id, actorUserId: actor.userId });
      if (!ref) {
        // 0 行: 他校 / 不可視 / 既に削除済み（RLS で弾かれた or deleted_at IS NOT NULL）。
        return null;
      }
      await writeAudit(tx, actor, {
        recordId: ref.id,
        schoolId: ref.schoolId,
        operation: "delete",
        diff: deleteAuditView(ref),
      });
      return ref;
    },
    { allowedRoles: TV_CONFIG_EDIT_ROLES },
  );

  if (!deleted) {
    return notFound("対象の TV デバイスが見つかりません（既に削除済みの可能性があります）。");
  }

  revalidatePath("/ops/tv-devices");
  revalidatePath(`/ops/tv-devices/${id}/edit`);
  return { ok: true, data: { id: deleted.id } };
}
