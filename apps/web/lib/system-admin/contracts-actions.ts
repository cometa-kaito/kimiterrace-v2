"use server";

import { type TenantTx, auditLog, contracts } from "@kimiterrace/db";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireRole } from "../auth/guard";
import { withSession } from "../db";
import {
  CONTRACT_STATUSES,
  type ContractCreateInput,
  type ContractStatus,
  type ContractUpdateInput,
  isValidContractStatusTransition,
  validateContractCreate,
  validateContractUpdate,
} from "./contracts-core";
import { SYSTEM_ADMIN_ROLES } from "./roles";
import { type ActionResult, conflict, invalid, isUuid, notFound } from "./schools-core";

/** PostgreSQL foreign_key_violation (advertiser_id → advertisers)。存在しない広告主を弾く。 */
function isForeignKeyViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23503"
  );
}

/** 対象契約が見つからない (RLS 不可視 / 不存在) とき tx をロールバックさせる。 */
class ContractNotFoundError extends Error {}

/** 許可されないステータス遷移 (terminated からの遷移・同一・矛盾) を表す。 */
class InvalidContractTransitionError extends Error {
  constructor(
    public readonly from: ContractStatus,
    public readonly to: ContractStatus,
  ) {
    super(`現在のステータス (${from}) からは ${to} へ変更できません。`);
  }
}

/** 読取〜書込の間に並行操作でステータスが変わった (楽観ロック競合)。 */
class ContractStatusChangedError extends Error {}

/**
 * F10 (#46): 広告主との契約 (CRM) を新規作成する Server Action (ADR-008 — 画面 mutation は Server Actions)。
 *
 * **認可 (system_admin 限定)**: `requireRole(SYSTEM_ADMIN_ROLES)` で school_admin / teacher を 403。
 * 契約は cross-tenant の横断データで system_admin 専用 (ADR-018/019、advertisers と同区分)。
 *
 * **RLS (ルール2)**: contracts は `system_admin_full_access` policy で、INSERT は WITH CHECK
 * (`current_user_role='system_admin'`) のときのみ通る。`withSession` は system_admin context を張るので
 * 本アクションは成立する。`getDb()` は非 BYPASSRLS の `kimiterrace_app` 接続。手書き WHERE は無く、
 * テナント境界は RLS が決める。
 *
 * **存在しない広告主**: `advertiser_id` は `restrict` FK。存在しない id を渡すと INSERT が
 * foreign_key_violation (23503) になるため `not_found` に倒す (検証段階では UUID 形式のみ確認し、
 * 実在は DB の参照整合性に委ねる)。
 *
 * **監査 (ルール1)**: 作成を同一 tx で audit_log に追記する。契約は紐づく学校が無いため `school_id=NULL`、
 * system_admin は users 行でないため `actor_user_id` / `created_by` / `updated_by` も NULL とする
 * (0005 policy が system_admin context の NULL school_id / NULL actor を許可)。
 */
export async function createContractAction(raw: {
  advertiserId?: unknown;
  status?: unknown;
  startedAt?: unknown;
  endedAt?: unknown;
  monthlyFeeJpy?: unknown;
  targetSchools?: unknown;
  notes?: unknown;
}): Promise<ActionResult<{ id: string }>> {
  const v = validateContractCreate(raw);
  if (!v.ok) {
    return invalid(v.message);
  }
  // 認可: system_admin のみ。redirect 副作用 (未認証→/login, 権限不足→/forbidden) はここで起きる。
  await requireRole(SYSTEM_ADMIN_ROLES);

  try {
    const data = await withSession(async (tx: TenantTx, user) => {
      const isSystemAdmin = user.role === "system_admin";
      const [row] = await tx
        .insert(contracts)
        .values({
          advertiserId: v.value.advertiserId,
          status: v.value.status,
          startedAt: v.value.startedAt,
          endedAt: v.value.endedAt,
          monthlyFeeJpy: v.value.monthlyFeeJpy,
          targetSchools: v.value.targetSchools,
          notes: v.value.notes,
          // system_admin は users 行ではないため監査カラムの actor は NULL (FK は users(id))。
          createdBy: isSystemAdmin ? null : user.uid,
          updatedBy: isSystemAdmin ? null : user.uid,
        })
        .returning({ id: contracts.id });
      if (!row) {
        // 多層防御: INSERT が 0 行 = RLS WITH CHECK 不成立 (本来 403 で来ない)。
        throw new Error("contract insert returned no row");
      }
      await writeContractAudit(tx, user, row.id, v.value);
      return { id: row.id };
    });
    revalidatePath(`/admin/system/advertisers/${v.value.advertiserId}/edit`);
    return { ok: true, data };
  } catch (error) {
    if (isForeignKeyViolation(error)) {
      return notFound("指定された広告主が見つかりません。");
    }
    throw error;
  }
}

/**
 * audit_log に 1 行追記 (ルール1 / NFR04)。prev_hash/row_hash は BEFORE INSERT トリガが計算。
 * 契約は cross-tenant なので `school_id=NULL`、system_admin は actor 系も NULL。
 * 日付は jsonb diff 内で ISO 文字列に明示変換する (Date のまま入れない、表現を安定させる)。
 */
async function writeContractAudit(
  tx: TenantTx,
  user: { uid: string; role: string },
  contractId: string,
  input: ContractCreateInput,
): Promise<void> {
  const isSystemAdmin = user.role === "system_admin";
  await tx.insert(auditLog).values({
    actorUserId: isSystemAdmin ? null : user.uid,
    schoolId: null,
    tableName: "contracts",
    recordId: contractId,
    operation: "insert",
    diff: {
      after: {
        advertiserId: input.advertiserId,
        status: input.status,
        startedAt: input.startedAt.toISOString(),
        endedAt: input.endedAt ? input.endedAt.toISOString() : null,
        monthlyFeeJpy: input.monthlyFeeJpy,
        targetSchools: input.targetSchools,
        notes: input.notes,
      },
    },
    rowHash: "",
    createdBy: isSystemAdmin ? null : user.uid,
    updatedBy: isSystemAdmin ? null : user.uid,
  });
}

/**
 * F10 (#46): 契約のステータスをライフサイクルに沿って遷移させる Server Action
 * (draft→active→paused→terminated、`contracts-core` の `CONTRACT_STATUS_TRANSITIONS`)。
 *
 * **認可 / RLS (ルール2)**: 作成と同様 `requireRole(SYSTEM_ADMIN_ROLES)` + contracts
 * `system_admin_full_access` の UPDATE。手書き WHERE は対象特定であってテナント境界ではない。
 *
 * **遷移ガード**: 現在ステータスを同一 tx で SELECT し (兼 not_found 検出)、`isValidContractStatusTransition`
 * で許可された遷移のみ通す。終端 (terminated) からの遷移・同一ステータスへの no-op・矛盾遷移は `conflict`。
 *
 * **TOCTOU 回避 (楽観ロック)**: UPDATE の WHERE に**読み取った時点の status を条件として含める**
 * (`id = $id AND status = $before`)。これにより「検証 → 更新」が単一行の compare-and-swap になり、
 * 読取〜書込の間に並行リクエストが先に遷移を commit した場合は UPDATE が 0 行に倒れ、`conflict` を返す
 * (lost-update を防ぐ。SELECT は FOR UPDATE 不要)。
 *
 * **not_found**: 対象が RLS 不可視 / 不存在なら SELECT が 0 行で `not_found`。
 *
 * **監査 (ルール1)**: 変更前後のステータスを同一 tx で audit_log に記録 (op=update)。`updated_at` は
 * auditColumns では INSERT 時のみ default のため UPDATE では明示更新する。契約は cross-tenant なので
 * school_id / actor は NULL。
 */
export async function updateContractStatusAction(raw: {
  id?: unknown;
  status?: unknown;
}): Promise<ActionResult<{ id: string; status: ContractStatus }>> {
  if (!isUuid(raw.id)) {
    return invalid("契約の指定が不正です。");
  }
  if (
    typeof raw.status !== "string" ||
    !(CONTRACT_STATUSES as readonly string[]).includes(raw.status)
  ) {
    return invalid("契約ステータスが不正です。");
  }
  const id = raw.id;
  const next = raw.status as ContractStatus;
  await requireRole(SYSTEM_ADMIN_ROLES);

  try {
    const data = await withSession(async (tx: TenantTx, user) => {
      const isSystemAdmin = user.role === "system_admin";
      // 現在ステータス + 広告主 id を同一 tx で取得 (not_found 検出 + 遷移検証 + revalidate 先)。
      const [before] = await tx
        .select({ status: contracts.status, advertiserId: contracts.advertiserId })
        .from(contracts)
        .where(eq(contracts.id, id))
        .limit(1);
      if (!before) {
        throw new ContractNotFoundError();
      }
      if (!isValidContractStatusTransition(before.status, next)) {
        throw new InvalidContractTransitionError(before.status, next);
      }
      const updated = await tx
        .update(contracts)
        // 楽観ロック: 読み取った status を条件に含め、並行遷移が先に commit したら 0 行に倒す。
        .set({ status: next, updatedBy: isSystemAdmin ? null : user.uid, updatedAt: new Date() })
        .where(and(eq(contracts.id, id), eq(contracts.status, before.status)))
        .returning({ id: contracts.id });
      if (updated.length === 0) {
        // SELECT は通ったが status 条件付き UPDATE が 0 行 = 読取〜書込の間に並行遷移が commit
        // (RLS 越境は前段 SELECT で除外済みのため、status 変化と判断する)。
        throw new ContractStatusChangedError();
      }
      await writeContractStatusAudit(tx, user, id, before.status, next);
      return { id, status: next, advertiserId: before.advertiserId };
    });
    revalidatePath(`/admin/system/advertisers/${data.advertiserId}/edit`);
    return { ok: true, data: { id: data.id, status: data.status } };
  } catch (error) {
    if (error instanceof ContractNotFoundError) {
      return notFound("指定された契約が見つかりません。");
    }
    if (error instanceof InvalidContractTransitionError) {
      return conflict(error.message);
    }
    if (error instanceof ContractStatusChangedError) {
      return conflict("契約のステータスが他の操作で変更されました。再読み込みしてください。");
    }
    throw error;
  }
}

/** ステータス遷移を audit_log に追記 (operation=update、diff は変更前後の status)。 */
async function writeContractStatusAudit(
  tx: TenantTx,
  user: { uid: string; role: string },
  contractId: string,
  before: ContractStatus,
  after: ContractStatus,
): Promise<void> {
  const isSystemAdmin = user.role === "system_admin";
  await tx.insert(auditLog).values({
    actorUserId: isSystemAdmin ? null : user.uid,
    schoolId: null,
    tableName: "contracts",
    recordId: contractId,
    operation: "update",
    diff: { before: { status: before }, after: { status: after } },
    rowHash: "",
    createdBy: isSystemAdmin ? null : user.uid,
    updatedBy: isSystemAdmin ? null : user.uid,
  });
}

/** audit diff 用に契約条件を JSON 安全な形へ (日付は ISO 文字列、targetSchools/notes はそのまま)。 */
type AuditableTerms = {
  startedAt: Date;
  endedAt: Date | null;
  monthlyFeeJpy: number;
  targetSchools: unknown;
  notes: string | null;
};
function termsForAudit(t: AuditableTerms) {
  return {
    startedAt: t.startedAt.toISOString(),
    endedAt: t.endedAt ? t.endedAt.toISOString() : null,
    monthlyFeeJpy: t.monthlyFeeJpy,
    targetSchools: t.targetSchools,
    notes: t.notes,
  };
}

/**
 * F10 (#46): 契約の可変フィールド (開始/終了日・月額・配信対象校・備考) を編集する Server Action。
 * advertiserId は不変 (別広告主への付替えは新規契約で表現)、status は遷移アクション
 * (`updateContractStatusAction`) の管轄なのでここでは触らない。
 *
 * **認可 / RLS (ルール2)**: `requireRole(SYSTEM_ADMIN_ROLES)` + contracts `system_admin_full_access`
 * の UPDATE。手書き WHERE は対象特定であってテナント境界ではない。`withSession` は非 BYPASSRLS。
 *
 * **not_found**: 対象が RLS 不可視 / 不存在なら SELECT が 0 行で `not_found` (多層防御で UPDATE 0 行も同様)。
 *
 * **監査 (ルール1)**: 変更前後の可変フィールドを同一 tx で audit_log に記録 (op=update、日付は ISO)。
 * `updated_at` は auditColumns では INSERT 時のみ default のため UPDATE で明示更新する。契約は
 * cross-tenant なので school_id / actor は NULL。
 */
export async function updateContractAction(
  id: unknown,
  raw: {
    startedAt?: unknown;
    endedAt?: unknown;
    monthlyFeeJpy?: unknown;
    targetSchools?: unknown;
    notes?: unknown;
  },
): Promise<ActionResult<{ id: string }>> {
  if (!isUuid(id)) {
    return invalid("契約の指定が不正です。");
  }
  const contractId = id;
  const v = validateContractUpdate(raw);
  if (!v.ok) {
    return invalid(v.message);
  }
  await requireRole(SYSTEM_ADMIN_ROLES);

  try {
    const data = await withSession(async (tx: TenantTx, user) => {
      const isSystemAdmin = user.role === "system_admin";
      // 監査の before 用に更新前の可変フィールド + 広告主 id (revalidate 先) を同一 tx で取得
      // (兼 not_found 検出)。
      const [before] = await tx
        .select({
          startedAt: contracts.startedAt,
          endedAt: contracts.endedAt,
          monthlyFeeJpy: contracts.monthlyFeeJpy,
          targetSchools: contracts.targetSchools,
          notes: contracts.notes,
          advertiserId: contracts.advertiserId,
        })
        .from(contracts)
        .where(eq(contracts.id, contractId))
        .limit(1);
      if (!before) {
        throw new ContractNotFoundError();
      }
      const updated = await tx
        .update(contracts)
        .set({
          startedAt: v.value.startedAt,
          endedAt: v.value.endedAt,
          monthlyFeeJpy: v.value.monthlyFeeJpy,
          targetSchools: v.value.targetSchools,
          notes: v.value.notes,
          updatedBy: isSystemAdmin ? null : user.uid,
          updatedAt: new Date(),
        })
        .where(eq(contracts.id, contractId))
        .returning({ id: contracts.id });
      if (updated.length === 0) {
        // 多層防御: SELECT が通って UPDATE が 0 行 = RLS 越境 (本来到達しない)。
        throw new ContractNotFoundError();
      }
      await writeContractUpdateAudit(tx, user, contractId, before, v.value);
      return { id: contractId, advertiserId: before.advertiserId };
    });
    revalidatePath(`/admin/system/advertisers/${data.advertiserId}/edit`);
    return { ok: true, data: { id: data.id } };
  } catch (error) {
    if (error instanceof ContractNotFoundError) {
      return notFound("指定された契約が見つかりません。");
    }
    throw error;
  }
}

/** 可変フィールド編集を audit_log に追記 (operation=update、diff は変更前後の契約条件)。 */
async function writeContractUpdateAudit(
  tx: TenantTx,
  user: { uid: string; role: string },
  contractId: string,
  before: AuditableTerms,
  after: ContractUpdateInput,
): Promise<void> {
  const isSystemAdmin = user.role === "system_admin";
  await tx.insert(auditLog).values({
    actorUserId: isSystemAdmin ? null : user.uid,
    schoolId: null,
    tableName: "contracts",
    recordId: contractId,
    operation: "update",
    diff: { before: termsForAudit(before), after: termsForAudit(after) },
    rowHash: "",
    createdBy: isSystemAdmin ? null : user.uid,
    updatedBy: isSystemAdmin ? null : user.uid,
  });
}
