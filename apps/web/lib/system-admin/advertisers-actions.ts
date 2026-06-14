"use server";

import { type TenantTx, advertisers, auditLog } from "@kimiterrace/db";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireRole } from "../auth/guard";
import { withSession } from "../db";
import {
  type AdvertiserEditInput,
  type AdvertiserStatus,
  isActiveForStatus,
  validateAdvertiserEdit,
} from "./advertisers-core";
import { SYSTEM_ADMIN_ROLES } from "./roles";
import { type ActionResult, invalid, isUuid, notFound } from "./schools-core";

/** 対象広告主が見つからない (RLS 不可視 / 不存在) とき tx をロールバックさせる。 */
class AdvertiserNotFoundError extends Error {}

/**
 * F10 (#46) / 実装設計書 §4「advertisers/[id]/edit 最小縮退」: 広告主の **表示名 (会社名) と配信ステータス
 * (稼働中 / 休止)** を編集する Server Action。業種・連絡先・住所・備考は portal が正のため受け取らず、
 * **既存の商流フィールドは一切上書き・消去しない** (縮退フォームから送られないフィールドを null で潰さない)。
 * 配信ステータスは緊急停止スイッチ (休止=配信対象外) で、バグ「休止が配信に反映されない」の修正対象箇所のため死守する。
 *
 * **認可 / RLS**: `requireRole(SYSTEM_ADMIN_ROLES)` + advertisers `system_admin_full_access` の UPDATE (ルール2)。
 * 検証は `validateAdvertiserEdit` (会社名必須 + 配信ステータス 2 値) を使う。
 *
 * **not_found**: 対象が RLS 不可視 / 不存在なら UPDATE が 0 行に倒れ `not_found` を返す (手書き WHERE は
 * 対象特定であってテナント境界ではない)。
 *
 * **監査 (ルール1)**: 変更前後 (会社名 + status) を同一 tx で audit_log に記録する。advertisers は cross-tenant
 * なので school_id は NULL、actor_user_id は FK 制約で NULL だが actor_identity_uid に IdP uid を載せ立証可能にする。
 */
export async function updateAdvertiserAction(
  id: unknown,
  raw: {
    companyName?: unknown;
    status?: unknown;
  },
): Promise<ActionResult<{ id: string }>> {
  if (!isUuid(id)) {
    return invalid("広告主の指定が不正です。");
  }
  const advertiserId = id;
  // 縮退フォーム専用の検証 (会社名必須 + 配信ステータスは active/paused のみ)。
  const v = validateAdvertiserEdit(raw);
  if (!v.ok) {
    return invalid(v.message);
  }
  await requireRole(SYSTEM_ADMIN_ROLES);

  try {
    const data = await withSession(async (tx: TenantTx, user) => {
      const isSystemAdmin = user.role === "system_admin";
      // 監査の before 用に更新対象フィールドのみを同一 tx で取得 (兼 not_found 検出)。
      const [before] = await tx
        .select({
          companyName: advertisers.companyName,
          status: advertisers.status,
        })
        .from(advertisers)
        .where(eq(advertisers.id, advertiserId))
        .limit(1);
      if (!before) {
        throw new AdvertiserNotFoundError();
      }
      const updated = await tx
        .update(advertisers)
        // 表示名と配信ステータスのみ更新する。業種・連絡先・住所・備考には触れない (portal が正)。
        .set({
          companyName: v.value.companyName,
          status: v.value.status,
          // 不変条件 (PR #534): is_active は status から導出して整合させる (paused ⟺ false)。
          isActive: isActiveForStatus(v.value.status),
          // updated_at は auditColumns では INSERT 時のみ default のため UPDATE では明示更新する
          // (sibling UPDATE と同方針、ルール1: 監査カラム整合)。
          updatedBy: isSystemAdmin ? null : user.uid,
          updatedAt: new Date(),
        })
        .where(eq(advertisers.id, advertiserId))
        .returning({ id: advertisers.id });
      if (updated.length === 0) {
        // 多層防御: SELECT が通って UPDATE が 0 行 = RLS 越境 (本来到達しない)。
        throw new AdvertiserNotFoundError();
      }
      await writeAdvertiserUpdateAudit(tx, user, advertiserId, before, v.value);
      return { id: advertiserId };
    });
    revalidatePath("/ops/advertisers");
    revalidatePath(`/ops/advertisers/${advertiserId}/edit`);
    return { ok: true, data };
  } catch (error) {
    if (error instanceof AdvertiserNotFoundError) {
      return notFound("指定された広告主が見つかりません。");
    }
    throw error;
  }
}

/** 表示名・配信ステータス編集を audit_log に追記 (operation=update、diff は変更前後)。 */
async function writeAdvertiserUpdateAudit(
  tx: TenantTx,
  user: { uid: string; role: string },
  advertiserId: string,
  before: { companyName: string; status: AdvertiserStatus },
  after: AdvertiserEditInput,
): Promise<void> {
  // system_admin は users 行ではないため actor_user_id / created_by / updated_by は FK 制約で null
  // にせざるを得ない。実行者は FK の無い actor_identity_uid に IdP uid を必ず載せて、users 行の有無に
  // 依らず「誰がやったか」を立証可能にする (ルール1 / NFR04、operator-ads-actions・view-audit と同方針)。
  const actorRef = user.role === "system_admin" ? null : user.uid;
  await tx.insert(auditLog).values({
    actorUserId: actorRef,
    actorIdentityUid: user.uid,
    schoolId: null,
    tableName: "advertisers",
    recordId: advertiserId,
    operation: "update",
    diff: { before, after },
    rowHash: "",
    createdBy: actorRef,
    updatedBy: actorRef,
  });
}

/**
 * F10 (#46): 広告主の稼働状態 (`is_active`) を切り替える Server Action。停止 = 論理削除
 * (advertisers schema: 過去契約のトレースを残すため物理 DELETE しない)、再開でその逆。
 *
 * 認可は `requireRole(SYSTEM_ADMIN_ROLES)` (system_admin 限定)。UPDATE は advertisers の
 * `system_admin_full_access` policy で通る (ルール2)。対象が RLS で不可視 / 不存在なら UPDATE が 0 行と
 * なり `not_found` に倒す (手書き WHERE は対象特定であってテナント境界ではない)。状態変更を同一 tx で
 * audit_log に記録する (ルール1、advertisers は cross-tenant なので school_id は NULL、actor_user_id は
 * FK 制約で NULL だが actor_identity_uid に IdP uid を載せ「誰が」を立証可能にする)。
 */
export async function setAdvertiserActiveAction(raw: {
  id?: unknown;
  isActive?: unknown;
}): Promise<ActionResult<{ id: string; isActive: boolean }>> {
  if (!isUuid(raw.id)) {
    return invalid("広告主の指定が不正です。");
  }
  if (typeof raw.isActive !== "boolean") {
    return invalid("状態の指定が不正です。");
  }
  const id = raw.id;
  const isActive = raw.isActive;
  await requireRole(SYSTEM_ADMIN_ROLES);

  try {
    // 不変条件 (PR #534): 停止 = status:'paused' / 再開 = status:'active' を同時に set し、is_active と
    // status のズレを防ぐ。再開時に元が 'prospect' だったかは区別せず 'active' に倒す (稼働=契約中扱い)。
    const status: AdvertiserStatus = isActive ? "active" : "paused";
    const data = await withSession(async (tx: TenantTx, user) => {
      const isSystemAdmin = user.role === "system_admin";
      const updated = await tx
        .update(advertisers)
        // updated_at は auditColumns では INSERT 時のみ default のため UPDATE では明示更新する
        // (sibling の schools/magic-links/contents の UPDATE と同方針、ルール1: 監査カラム整合)。
        .set({
          isActive,
          status,
          updatedBy: isSystemAdmin ? null : user.uid,
          updatedAt: new Date(),
        })
        .where(eq(advertisers.id, id))
        .returning({ id: advertisers.id });
      if (updated.length === 0) {
        throw new AdvertiserNotFoundError();
      }
      await writeAdvertiserActiveAudit(tx, user, id, isActive, status);
      return { id, isActive };
    });
    revalidatePath("/ops/advertisers");
    return { ok: true, data };
  } catch (error) {
    if (error instanceof AdvertiserNotFoundError) {
      return notFound("指定された広告主が見つかりません。");
    }
    throw error;
  }
}

/** 稼働状態変更を audit_log に追記 (operation=update、diff は変更後の is_active + 連動 status)。 */
async function writeAdvertiserActiveAudit(
  tx: TenantTx,
  user: { uid: string; role: string },
  advertiserId: string,
  isActive: boolean,
  status: AdvertiserStatus,
): Promise<void> {
  // 編集監査と同方針: system_admin は users 行が無く actor_user_id 等は FK 制約で null。実行者は
  // FK の無い actor_identity_uid に IdP uid を載せ、休止/再開の実行者を立証可能にする (ルール1 / NFR04)。
  const actorRef = user.role === "system_admin" ? null : user.uid;
  await tx.insert(auditLog).values({
    actorUserId: actorRef,
    actorIdentityUid: user.uid,
    schoolId: null,
    tableName: "advertisers",
    recordId: advertiserId,
    operation: "update",
    diff: { after: { isActive, status } },
    rowHash: "",
    createdBy: actorRef,
    updatedBy: actorRef,
  });
}
