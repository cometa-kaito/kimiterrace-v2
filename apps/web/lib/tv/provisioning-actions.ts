"use server";

import {
  DEFAULT_SIGNAGE_TTL_DAYS,
  type TenantTx,
  auditLog,
  buildSignageUrl,
  createProvisioningJob,
  createTvDevice,
  generateToken,
  hashToken,
  magicLinks,
  resolveSignageBaseUrl,
} from "@kimiterrace/db";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { requireRole } from "../auth/guard";
import { withSession } from "../db";
import { type ActionResult, conflict, invalid } from "./config-edit-core";
import { ONBOARDING_ROLES } from "./onboarding-core";
import { type ProvisioningInput, validateProvisioningInput } from "./provisioning-core";

/**
 * C方式 TV プロビジョニング: ジョブ作成の Server Action（ADR-008 — 画面 mutation は Server Actions）。
 *
 * 操作: 入力検証 → 認可（`requireRole(ONBOARDING_ROLES)` = **system_admin 限定**、onboarding と同境界・
 * cross-tenant 設置のため）→ device_id 解決（未指定なら UUIDv4）→ **signage_url 発行**（packages/db の純
 * ロジックを seed CLI と共有、token plaintext は signage_url のみ・DB は hash）→ `withSession`（system_admin
 * context）で **同一 tx に 4 つの書込み**:
 *   1. `tv_devices` 行を事前作成（signage_url を焼く、createTvDevice）。
 *   2. サイネージ magic link を発行（hash のみ・class スコープ・1 年＝学年度カバー）。composite FK (class_id, school_id) が
 *      「クラスが当該校に属す」ことを INSERT 時に DB で強制する（越境 class_id は 23503）。
 *   3. デバイス登録の監査（onboarding と同形、system_admin は actor_user_id=null + actor_identity_uid）。
 *   4. プロビジョニングジョブ作成（createProvisioningJob、job 監査は同関数が書く）。
 *
 * **秘密非格納（ルール5）**: ジョブには鍵を載せない。`config_endpoint` の poll secret は現地エージェントが
 * Secret Manager から取得し prefs に注入する。本 Action が DB に書くのは非秘密パラメータと signage_url（=
 * token plaintext を載せるが、これは表示 URL であり magic link の hash で保護される read 専用トークン）。
 *
 * @returns 作成した `{ jobId, deviceId, signageUrl }`。jobId は UI のライブ進捗ポーリングに使う。
 */

/**
 * PostgreSQL の SQLSTATE を取り出す（Drizzle は `PostgresError` を `DrizzleQueryError` で包み code が
 * `.cause` 側に乗るため cause 連鎖を辿る。[[feedback_drizzle_query_error_cause_sqlstate]]）。
 */
function pgCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") {
      return code;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export async function createProvisioningJobAction(
  rawInput: ProvisioningInput,
): Promise<ActionResult<{ jobId: string; deviceId: string; signageUrl: string }>> {
  const v = validateProvisioningInput(rawInput);
  if (!v.ok) {
    return invalid(v.message);
  }
  // system_admin 限定。role 不足は requireRole が /forbidden へ。
  const user = await requireRole(ONBOARDING_ROLES);
  const { schoolId, classId, config } = v.value;
  const deviceId = v.value.deviceId ?? randomUUID();
  const targetIp = v.value.targetIp;

  // signage_url 発行（packages/db の純ロジック = seed CLI と単一ソース）。plaintext は signage_url にのみ載せ、
  // DB の magic_links には hash しか残さない（ルール5）。base は県教委 Wi-Fi 許可 FQDN（既定 app.school-signage.net）。
  const base = resolveSignageBaseUrl(process.env.SIGNAGE_BASE_URL);
  const token = generateToken();
  const signageUrl = buildSignageUrl(base, token);
  const tokenHash = hashToken(token);

  try {
    const result = await withSession(
      async (tx: TenantTx) => {
        // 1. tv_devices 行を事前作成（signage_url を焼く）。system_admin は users 行でないため created_by=null。
        const ref = await createTvDevice(tx, {
          deviceId,
          schoolId,
          label: config.label,
          targetMac: config.targetMac,
          signageUrl,
          webhookUrl: config.webhookUrl,
          scheduleJson: config.scheduleJson,
          monitoringEnabled: config.monitoringEnabled,
          notes: config.notes,
          createdBy: null,
        });
        // 2. サイネージ magic link 発行（hash のみ・class スコープ・1 年＝学年度カバー）。expires_at は Date を bind せず
        //    DB 側 make_interval で算出（[[feedback_pg_date_bind_enum_insert]]）。composite FK が class∈school を強制。
        await tx.insert(magicLinks).values({
          schoolId,
          classId,
          userId: null,
          tokenHash,
          expiresAt: sql`now() + make_interval(days => ${DEFAULT_SIGNAGE_TTL_DAYS}::int)`,
          createdBy: null,
          updatedBy: null,
        });
        // 3. デバイス登録の監査（ルール1、onboarding と同形）。
        await tx.insert(auditLog).values({
          actorUserId: null,
          actorIdentityUid: user.uid,
          schoolId,
          tableName: "tv_devices",
          recordId: ref.id,
          operation: "insert",
          diff: { after: { deviceId: ref.deviceId, label: config.label, signageUrl } },
          rowHash: "",
          createdBy: null,
          updatedBy: null,
        });
        // 4. プロビジョニングジョブ作成（job 監査は createProvisioningJob が同 tx で残す）。
        const job = await createProvisioningJob(tx, {
          schoolId,
          classId,
          tvDeviceRowId: ref.id,
          deviceId: ref.deviceId,
          targetIp,
          signageUrl,
          scheduleJson: config.scheduleJson,
          targetMac: config.targetMac,
          actorUserId: null,
          actorIdentityUid: user.uid,
        });
        return { jobId: job.id, deviceId: ref.deviceId, signageUrl };
      },
      { allowedRoles: ONBOARDING_ROLES },
    );

    revalidatePath("/ops/tv-devices/provision");
    revalidatePath("/ops/tv-devices");
    return { ok: true, data: result };
  } catch (error) {
    const code = pgCode(error);
    if (code === "23505") {
      // device_id グローバル UNIQUE 違反（既に登録済 / 別校が同一 device_id を使用）。
      return conflict(
        "この device_id は既に登録されています。空欄にして自動生成するか、別の値を指定してください。",
      );
    }
    if (code === "23503") {
      // school_id / class_id の FK 違反（存在しない学校・クラス、またはクラスが当該校に属さない）。
      return invalid(
        "設置先の学校またはクラスが見つかりません。学校とクラスを選び直してください。",
      );
    }
    throw error;
  }
}
