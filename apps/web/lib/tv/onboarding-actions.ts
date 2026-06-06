"use server";

import { type TenantTx, auditLog, createTvDevice } from "@kimiterrace/db";
import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { requireRole } from "../auth/guard";
import { withSession } from "../db";
import { type ActionResult, type TvConfigEditPatch, conflict, invalid } from "./config-edit-core";
import { ONBOARDING_ROLES, type TvOnboardingInput, validateTvOnboarding } from "./onboarding-core";

/**
 * F15 §4.3 (ADR-022 / ADR-008 — 画面 mutation は Server Actions): TV デバイス新規登録（オンボーディング）の
 * Server Action。
 *
 * 操作: 入力検証 → 認可 (`requireRole(ONBOARDING_ROLES)` = **system_admin 限定**) → device_id 解決
 * （未指定なら UUIDv4 自動生成）→ `withSession`（role=system_admin context）で **INSERT + audit_log 追記** を
 * 同一 tx → `revalidatePath`。
 *
 * **cross-tenant 登録（F15 §4.3）**: system_admin は設置先 `schoolId` を入力で選び、任意校にデバイスを
 * 作成する。`withSession` の role=system_admin context で `tv_devices` の `system_admin_full_access` policy が
 * 任意校 INSERT を許可する（編集の `tenantScoped` 降格は使わない — あれは自校限定の操作用。登録は越境が前提）。
 * cross-tenant 越境の安全性は **device_id グローバル UNIQUE**（二重登録不可）+ **app 層の system_admin 認可**で
 * 担保する。school_admin が万一呼んでも RLS WITH CHECK が別校 INSERT を弾く（多層防御）。
 *
 * **監査 actor（ルール1 / NFR04, setStaffActiveAction と同パターン）**: 操作者は system_admin だが、
 * system_admin は `users` 行でなく `system_admins` 行（`uid = system_admins.id`）なので、users(id) FK を持つ
 * `actor_user_id` / `tv_devices.created_by` に uid を入れられない。よって FK 列は **null**（システム作成）にし、
 * 「誰が」は FK を持たない `actor_identity_uid`（IdP UID キャッシュ）に system_admin の uid を残して追跡可能に
 * する。audit_log の WITH CHECK は role=system_admin により actor=null / 任意 school を許可する（migration 0005）。
 *
 * **SSRF**: 保存する `signageUrl` / `webhookUrl` は config-edit と同じ `validateTvConfigEdit` で内部宛先を
 * 弾く。将来サーバ側 fetch を足す場合は保存時検証に依存せず fetch 時に解決済み IP を再検証すること
 * （config-edit-core.ts のコメント参照、DNS-rebinding 対策）。
 */

/** PostgreSQL のエラーコード（SQLSTATE）を取り出す。 */
function pgCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/** audit_log に新規登録（insert 操作）を 1 行追記。prev_hash/row_hash は BEFORE INSERT トリガが計算。 */
async function writeCreateAudit(
  tx: TenantTx,
  params: {
    actorIdentityUid: string;
    schoolId: string;
    recordId: string;
    deviceId: string;
    config: TvConfigEditPatch;
  },
): Promise<void> {
  await tx.insert(auditLog).values({
    // system_admin は users 行でないため actor_user_id（users FK）は null。誰がは actor_identity_uid に残す。
    actorUserId: null,
    actorIdentityUid: params.actorIdentityUid,
    schoolId: params.schoolId,
    tableName: "tv_devices",
    recordId: params.recordId,
    operation: "insert",
    // device_id（識別子、PII でない）と登録時の設定を after として残す。
    diff: { after: { deviceId: params.deviceId, ...params.config } },
    rowHash: "",
    createdBy: null,
    updatedBy: null,
  });
}

/**
 * TV デバイスを新規登録する（F15 §4.3）。
 *
 * @param rawInput 登録フォーム入力（deviceId 任意 / schoolId 必須 + 設定フィールド）。
 * @returns        作成行の `{ id, deviceId }`。id は編集・履歴リンクに使う行 PK、deviceId は TV 設定値。
 */
export async function createTvDeviceAction(
  rawInput: TvOnboardingInput,
): Promise<ActionResult<{ id: string; deviceId: string }>> {
  const v = validateTvOnboarding(rawInput);
  if (!v.ok) {
    return invalid(v.message);
  }
  // F15 §4.3: system_admin 限定。role 不足は requireRole が /forbidden へ。
  const user = await requireRole(ONBOARDING_ROLES);
  const { schoolId, config } = v.value;
  // device_id 未指定なら事前採番（推測不能 UUIDv4）。指定があれば TV 生成値の転記をそのまま使う。
  const deviceId = v.value.deviceId ?? randomUUID();

  try {
    const created = await withSession(
      async (tx) => {
        const ref = await createTvDevice(tx, {
          deviceId,
          schoolId,
          label: config.label,
          targetMac: config.targetMac,
          signageUrl: config.signageUrl,
          webhookUrl: config.webhookUrl,
          scheduleJson: config.scheduleJson,
          monitoringEnabled: config.monitoringEnabled,
          notes: config.notes,
          // system_admin は users 行でないため created_by は null（上記監査パターン）。
          createdBy: null,
        });
        await writeCreateAudit(tx, {
          actorIdentityUid: user.uid,
          schoolId,
          recordId: ref.id,
          deviceId: ref.deviceId,
          config,
        });
        return ref;
      },
      { allowedRoles: ONBOARDING_ROLES },
    );

    revalidatePath("/admin/tv-devices");
    return { ok: true, data: created };
  } catch (error) {
    const code = pgCode(error);
    if (code === "23505") {
      // device_id グローバル UNIQUE 違反（既に登録済 / 別校が同一 device_id を使用）。
      return conflict(
        "この device_id は既に登録されています。空欄にして自動生成するか、別の値を指定してください。",
      );
    }
    if (code === "23503") {
      // school_id の FK 違反（存在しない学校）。
      return invalid("設置先の学校が見つかりません。一覧から選び直してください。");
    }
    throw error;
  }
}
