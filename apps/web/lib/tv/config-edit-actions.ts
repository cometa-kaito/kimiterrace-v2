"use server";

import { type TenantTx, auditLog, updateTvDeviceConfig } from "@kimiterrace/db";
import { revalidatePath } from "next/cache";
import { requireRole } from "../auth/guard";
import { withSession } from "../db";
import {
  type ActionResult,
  type TvConfigEditActor,
  type TvConfigEditInput,
  type TvConfigEditPatch,
  TV_CONFIG_EDIT_ROLES,
  conflict,
  forbidden,
  invalid,
  isUuid,
  notFound,
  toTvConfigEditActor,
  validateTvConfigEdit,
} from "./config-edit-core";

/**
 * F15 §4.2 (ADR-022 / ADR-008 — 画面 mutation は Server Actions): TV デバイス設定編集の Server Action。
 *
 * 操作: 入力検証 → 認可 (`requireRole(TV_CONFIG_EDIT_ROLES)`) → actor 解決 → `withSession` の自校 RLS tx
 * 内で **オペレーター編集可能フィールドのみ UPDATE + version +1（ADR-022）** + `audit_log` 追記 →
 * `revalidatePath`。`tv_devices` は手書き WHERE school_id を持たず、RLS (`tenant_isolation`) が自校を
 * 強制する（ルール2）。0 行（他校 / 不可視 / 退役 TV）は `not_found` に写像する。
 *
 * **version バンプ（ADR-022）**: TV は応答 `version` の差分でのみ設定を反映する。設定変更時に version を
 * 上げないと TV が変更を検知できないため、`updateTvDeviceConfig` が同一 UPDATE で `version+1` する。
 *
 * **監査（ルール1 / NFR04）**: 設定変更は `audit_log` に 1 件残す（誰がいつ何を変更したか）。`updated_at`
 * は query 層が明示的に進める（[[updatedat-explicit-on-update]]）。心拍 touch（pollTvConfig）とは別経路。
 *
 * **system_admin の降格 (ADR-019 §#95 / Issue #226)**: 本 Action は特定デバイス（= 特定 school）対象の
 * テナントスコープ操作のため `withSession(..., { tenantScoped: true })` で実行する。TV_CONFIG_EDIT_ROLES は
 * system_admin を含むが、school_id claim を持つ system_admin の tx では `system_admin_full_access` policy が
 * 全校発火し他校デバイスも UPDATE 可能になりうる（cross-tenant 越権）。tenantScoped で role を school_admin
 * に降格すると当該 policy が止まり `tenant_isolation` だけが残るため他校行は不可視（0 行 → not_found）。
 * schoolId 無しの system_admin は降格されず toTvConfigEditActor が null → forbidden。
 *
 * **システム管理列の遮断**: `validateTvConfigEdit` は編集可能フィールドのみ受け取り、`device_id` /
 * `school_id` / `version` / `last_seen_at` / `alert_state` 等は型レベルで入ってこない（クライアント自由入力
 * からの混入も DB へ漏れない）。
 */

/** PostgreSQL の unique / check 制約違反 (SQLSTATE 23505 / 23514)。並行更新や制約違反など。 */
function isConstraintViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = (error as { code: unknown }).code;
  return code === "23505" || code === "23514";
}

/** audit_log に 1 行追記 (ルール1 / NFR04)。prev_hash/row_hash は BEFORE INSERT トリガが計算。 */
async function writeAudit(
  tx: TenantTx,
  actor: TvConfigEditActor,
  params: { recordId: string; diff: unknown },
): Promise<void> {
  await tx.insert(auditLog).values({
    actorUserId: actor.userId,
    schoolId: actor.schoolId,
    tableName: "tv_devices",
    recordId: params.recordId,
    operation: "update",
    diff: params.diff as object,
    rowHash: "",
    createdBy: actor.userId,
    updatedBy: actor.userId,
  });
}

/** 認可 + actor 解決。teacher / テナント未選択は forbidden。 */
async function authorize(): Promise<TvConfigEditActor | ActionResult<never>> {
  const user = await requireRole(TV_CONFIG_EDIT_ROLES);
  const actor = toTvConfigEditActor(user);
  if (!actor) {
    return forbidden("学校に属さないユーザーは TV 設定を編集できません。");
  }
  return actor;
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
  if ("ok" in actor) {
    return actor;
  }

  try {
    // ⚠️ SSRF: ここで保存する `patch.signageUrl` / `patch.webhookUrl` は将来も**サーバ側で fetch しない**
    // こと（現状シンク無し＝ADR-022 で TV 端末がクライアント側で叩く）。死活確認・プレビュー・画面
    // キャプチャ等でサーバ側 fetch を追加する場合は、保存時の `checkEditableUrl`（config-edit-core.ts）
    // 検証に依存せず、**fetch 時に解決済み IP を `isBlockedInternalHost` で再検証**すること
    // （DNS-rebinding 対策。公開ホスト名が解決時に 169.254.169.254 等の内部 IP へ化けうる）。
    // tenantScoped: system_admin を school_admin に降格し full_access policy の全校発火を止める
    // (ADR-019 §#95 / Issue #226)。本 Action は特定デバイス = 特定 school のテナントスコープ操作。
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
          diff: auditView(v.value, ref.version),
        });
        return ref;
      },
      { tenantScoped: true },
    );

    if (!updated) {
      return notFound("対象の TV デバイスが見つかりません。");
    }

    revalidatePath("/admin/tv-devices");
    revalidatePath(`/admin/tv-devices/${id}/edit`);
    return { ok: true, data: { id: updated.id, version: updated.version } };
  } catch (error) {
    if (isConstraintViolation(error)) {
      return conflict("他の操作と競合しました。最新の内容を読み込み直してください。");
    }
    throw error;
  }
}
