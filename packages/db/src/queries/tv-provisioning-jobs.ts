import { type InferSelectModel, and, asc, desc, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { TvProvisioningStatus } from "../_shared/enums.js";
import type { KimiterraceDb, TenantTx } from "../client.js";
import { withTenantContext } from "../client.js";
import { auditLog } from "../schema/audit-log.js";
import { tvProvisioningJobs } from "../schema/tv-provisioning-jobs.js";

/**
 * C方式 TV プロビジョニングジョブのクエリ層。3 経路（tv_device_commands と同じ二層 RLS 思想）:
 *
 *  1. **作成（管理セッション）**: `createProvisioningJob`。`/ops/tv-devices/provision` の Server Action が
 *     `withSession`（system_admin = ONBOARDING_ROLES）の RLS tx 内で呼ぶ。pending を 1 件 INSERT +
 *     `audit_log` 追記（同 tx・原子的、ルール1）。
 *  2. **claim（エージェント API・セッション無し）**: `claimNextProvisioningJob`。`POST /api/tv/provisioning/claim`
 *     から `system_admin` role context（cross-tenant、BYPASSRLS 不使用、ルール2）で最古の pending を
 *     `FOR UPDATE SKIP LOCKED` で 1 件 claim する（複数エージェント・二重 claim 競合に安全）。
 *  3. **status 報告（エージェント API・セッション無し）**: `reportProvisioningStatus`。同じく system_admin
 *     context で `claimed_by` 一致を必須にして status / current_step / steps_json / error を更新する
 *     （claim したエージェントのみ報告可 = 状態詐称防止）。
 *
 * 管理 UI 用の読み取り（`listProvisioningJobs` / `getProvisioningJob`）は呼び出し側の RLS context に委譲する
 * （system_admin は全校、school スコープは自校のみ）。型は schema から `InferSelectModel` で派生（ルール3）。
 */

type TvProvisioningJobRow = InferSelectModel<typeof tvProvisioningJobs>;

/** SELECT だけできれば良い（Drizzle db / トランザクションの両方を受ける）。 */
type Selectable = Pick<PostgresJsDatabase, "select">;

/** ジョブ状態の型を再エクスポート（呼び出し側が enums サブパスを知らずに使える）。単一ソースは enums.ts。 */
export type { TvProvisioningStatus };

export type CreateProvisioningJobParams = {
  /** 設置先の学校（テナントキー、必須）。 */
  schoolId: string;
  /** 設置クラス（任意・サイネージ文脈/ラベル用）。 */
  classId?: string | null;
  /** 事前作成した tv_devices 行 PK（任意）。 */
  tvDeviceRowId?: string | null;
  /** 対象 TV の device_id（事前採番、任意）。 */
  deviceId?: string | null;
  /** 現地 LAN 上の TV の IP（任意）。 */
  targetIp?: string | null;
  /** 発行済みサイネージ表示 URL（任意）。 */
  signageUrl?: string | null;
  /** 表示スケジュール（enabled / on_hour / off_hour / 曜日）。 */
  scheduleJson?: Record<string, unknown> | null;
  /** 県 Wi-Fi 固定 MAC（任意）。 */
  targetMac?: string | null;
  /** 失効期限（任意）。 */
  expiresAt?: Date | null;
  /** 監査 actor の users.id（system_admin は null）。 */
  actorUserId?: string | null;
  /** 監査 actor の Identity Platform UID（system_admin の追跡に必須）。 */
  actorIdentityUid?: string | null;
};

/**
 * 作成: プロビジョニングジョブを 1 件 INSERT し、監査を 1 件残す（同 tx・原子的）。
 *
 * @param tx     RLS context 下のトランザクション（Server Action の `withSession`、system_admin）。
 * @returns      作成行の `{ id }`。
 */
export async function createProvisioningJob(
  tx: TenantTx,
  params: CreateProvisioningJobParams,
): Promise<{ id: string }> {
  const inserted = await tx
    .insert(tvProvisioningJobs)
    .values({
      schoolId: params.schoolId,
      classId: params.classId ?? null,
      tvDeviceRowId: params.tvDeviceRowId ?? null,
      deviceId: params.deviceId ?? null,
      targetIp: params.targetIp ?? null,
      signageUrl: params.signageUrl ?? null,
      scheduleJson: params.scheduleJson ?? null,
      targetMac: params.targetMac ?? null,
      expiresAt: params.expiresAt ?? null,
      createdBy: params.actorUserId ?? null,
      updatedBy: params.actorUserId ?? null,
    })
    .returning({ id: tvProvisioningJobs.id });
  const id = inserted[0]?.id;
  if (id === undefined) {
    throw new Error("createProvisioningJob: tv_provisioning_jobs INSERT が行を返しませんでした");
  }

  // 監査（ルール1）: ジョブ作成を 1 件残す。system_admin は users 行でないため actor_user_id は null、
  // 誰がは actor_identity_uid に残す（writeCreateAudit と同形）。秘密・PII は diff に入れない。
  await tx.insert(auditLog).values({
    actorUserId: params.actorUserId ?? null,
    actorIdentityUid: params.actorIdentityUid ?? null,
    schoolId: params.schoolId,
    tableName: "tv_provisioning_jobs",
    recordId: id,
    operation: "insert",
    diff: {
      after: {
        device_id: params.deviceId ?? null,
        target_ip: params.targetIp ?? null,
        target_mac: params.targetMac ?? null,
      },
    },
    rowHash: "",
    createdBy: params.actorUserId ?? null,
    updatedBy: params.actorUserId ?? null,
  });

  return { id };
}

/** claim で返す非秘密パラメータ（鍵は含めない、ルール5）。エージェントが adb 実行に必要な最小集合。 */
export type ClaimedProvisioningJob = {
  id: string;
  schoolId: string;
  classId: string | null;
  deviceId: string | null;
  targetIp: string | null;
  signageUrl: string | null;
  scheduleJson: unknown;
  targetMac: string | null;
  status: TvProvisioningStatus;
};

/**
 * claim: 最古の `pending` ジョブを 1 件 `FOR UPDATE SKIP LOCKED` で原子的に claim する。
 *
 * `system_admin` role context（cross-tenant、`system_admin_full_access` policy）で走らせる。`SKIP LOCKED` に
 * より複数エージェントが同時に叩いても二重 claim しない（ロック済みの行は次の候補へスキップ）。claim できる
 * 行が無ければ `null`。鍵は返さず非秘密パラメータのみ返す（ルール5）。
 *
 * @param db       非 BYPASSRLS の Drizzle クライアント（本番 `getDb()`）。
 * @param agentId  claim するエージェント識別子（以後の status 報告の認可キー）。
 * @param options  `appRole`: テスト superuser を `kimiterrace_app` へ降格させ RLS を効かせる用。
 */
export async function claimNextProvisioningJob(
  db: KimiterraceDb,
  agentId: string,
  options?: { appRole?: string },
): Promise<ClaimedProvisioningJob | null> {
  return await withTenantContext(
    db,
    { role: "system_admin" },
    async (tx): Promise<ClaimedProvisioningJob | null> => {
      // 1. 最古の pending を 1 件ロック（SKIP LOCKED）。ロックは tx commit まで保持され二重 claim を防ぐ。
      const locked = await tx
        .select({ id: tvProvisioningJobs.id })
        .from(tvProvisioningJobs)
        .where(eq(tvProvisioningJobs.status, "pending"))
        .orderBy(asc(tvProvisioningJobs.createdAt))
        .limit(1)
        .for("update", { skipLocked: true });
      const lockedId = locked[0]?.id;
      if (lockedId === undefined) {
        return null;
      }
      // 2. claim（pending を再確認して claimed へ）。非秘密パラメータのみ RETURNING する。
      const updated = await tx
        .update(tvProvisioningJobs)
        .set({
          status: "claimed",
          claimedBy: agentId,
          claimedAt: sql`now()`,
          updatedAt: new Date(),
        })
        .where(and(eq(tvProvisioningJobs.id, lockedId), eq(tvProvisioningJobs.status, "pending")))
        .returning({
          id: tvProvisioningJobs.id,
          schoolId: tvProvisioningJobs.schoolId,
          classId: tvProvisioningJobs.classId,
          deviceId: tvProvisioningJobs.deviceId,
          targetIp: tvProvisioningJobs.targetIp,
          signageUrl: tvProvisioningJobs.signageUrl,
          scheduleJson: tvProvisioningJobs.scheduleJson,
          targetMac: tvProvisioningJobs.targetMac,
          status: tvProvisioningJobs.status,
        });
      return updated[0] ?? null;
    },
    { appRole: options?.appRole },
  );
}

/** ステップ結果ログ 1 件（steps_json 配列に追記。秘密・PII 非格納）。 */
export type ProvisioningStep = {
  /** ステップ名（preflight / install / device_owner / prefs / launch 等）。 */
  name: string;
  /** ステップ結果（ok / failed / skipped 等）。 */
  status: string;
  /** 機械メタ（factory-mac 一致判定・捕捉した IP/GW 等。秘密値は載せない）。 */
  detail?: Record<string, unknown>;
  /** エージェント側の記録時刻（ISO 文字列、任意）。 */
  at?: string;
};

export type ReportProvisioningStatusParams = {
  /** 対象ジョブ id。 */
  jobId: string;
  /** 報告元エージェント（claim 時の値と一致必須 = 状態詐称防止）。 */
  agentId: string;
  /** 新しい段階状態（任意）。 */
  status?: TvProvisioningStatus;
  /** 直近ステップの人間可読ラベル（任意）。 */
  currentStep?: string | null;
  /** steps_json に追記するステップ結果（任意）。 */
  step?: ProvisioningStep;
  /** 失敗要約（任意）。 */
  error?: string | null;
  /** reset で再生成された実機 device_id を後追い報告する場合（任意）。 */
  deviceId?: string | null;
};

export type ReportProvisioningStatusResult = { status: "updated" } | { status: "not_found" };

/**
 * status 報告: claim したエージェントが段階状態・ステップ結果を更新する。
 *
 * `system_admin` role context で `(id, claimed_by=agentId)` を突き合わせて 1 行を解決する（claim した
 * エージェントのみ報告可・他エージェントの jobId を更新できない多層防御）。`step` を渡すと `steps_json`
 * 配列の末尾に追記する（`coalesce(steps_json,'[]') || step`）。一致行が無ければ `not_found`。
 *
 * @param db       非 BYPASSRLS の Drizzle クライアント（本番 `getDb()`）。
 * @param options  `appRole`: テスト superuser を `kimiterrace_app` へ降格させ RLS を効かせる用。
 */
export async function reportProvisioningStatus(
  db: KimiterraceDb,
  params: ReportProvisioningStatusParams,
  options?: { appRole?: string },
): Promise<ReportProvisioningStatusResult> {
  return await withTenantContext(
    db,
    { role: "system_admin" },
    async (tx): Promise<ReportProvisioningStatusResult> => {
      const updated = await tx
        .update(tvProvisioningJobs)
        .set({
          // updated_at は明示（auditColumns に $onUpdate / トリガ無し、[[updatedat-explicit-on-update]]）。
          updatedAt: new Date(),
          ...(params.status ? { status: params.status } : {}),
          ...(params.currentStep !== undefined ? { currentStep: params.currentStep } : {}),
          ...(params.error !== undefined ? { error: params.error } : {}),
          ...(params.deviceId ? { deviceId: params.deviceId } : {}),
          // jsonb 配列追記。Date を bind せず JSON.stringify(...)::jsonb で渡す（[[pg-date-bind-enum-insert]]）。
          ...(params.step
            ? {
                stepsJson: sql`coalesce(${tvProvisioningJobs.stepsJson}, '[]'::jsonb) || ${JSON.stringify([params.step])}::jsonb`,
              }
            : {}),
        })
        .where(
          and(
            eq(tvProvisioningJobs.id, params.jobId),
            eq(tvProvisioningJobs.claimedBy, params.agentId),
          ),
        )
        .returning({ id: tvProvisioningJobs.id });
      return updated.length > 0 ? { status: "updated" } : { status: "not_found" };
    },
    { appRole: options?.appRole },
  );
}

/**
 * 管理一覧: プロビジョニングジョブを新しい順に取得する（呼び出し側の RLS context に委譲）。
 * system_admin context は全校、school スコープは自校のみ。
 */
export async function listProvisioningJobs(
  db: Selectable,
  limit = 50,
): Promise<TvProvisioningJobRow[]> {
  return db
    .select()
    .from(tvProvisioningJobs)
    .orderBy(desc(tvProvisioningJobs.createdAt))
    .limit(limit);
}

/** 管理詳細 / ライブ進捗: 単件取得（RLS スコープ外なら null）。 */
export async function getProvisioningJob(
  db: Selectable,
  id: string,
): Promise<TvProvisioningJobRow | null> {
  const rows = await db
    .select()
    .from(tvProvisioningJobs)
    .where(eq(tvProvisioningJobs.id, id))
    .limit(1);
  return rows[0] ?? null;
}
