"use server";

import { type TenantTx, ads, auditLog, getSchoolDetail } from "@kimiterrace/db";
import { and, eq, isNotNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireRole } from "../auth/guard";
import { withSession } from "../db";
import {
  type ActionResult,
  type AdInput,
  conflict,
  invalid,
  isUuid,
  notFound,
  validateAdInput,
} from "../school-admin/ads-core";
import { getAdvertiserDetail } from "./advertisers-queries";
import { SYSTEM_ADMIN_ROLES } from "./roles";

/**
 * F10 / #46: **運営側広告 CRM の Server Actions**（system_admin 専用）。
 *
 * 運営が広告主のために広告を入稿（`scope='school'` ＝対象校の全クラスに表示、`advertiser_id` で紐付け）し、
 * 削除する。学校 (school_admin) の自校クラス広告（`ads-actions.ts`）とは別サーフェスで、こちらは
 * **広告主アカウント単位**で管理する。
 *
 * **認可・テナント**: `requireRole(SYSTEM_ADMIN_ROLES)`。**全校書込は system_admin の RLS
 * (system_admin_full_access) が許可**（school_admin の `toAdsActor` は自校 schoolId を要求するため運営には
 * 使えない＝こちらは対象校を入力で受け取り、監査の school_id も対象校にする）。対象の広告主/学校は実在を
 * 確認してから書く（FK 違反前に明確なメッセージ）。caption/mediaUrl はログに丸出ししない（監査は要約）。
 */

class NotFoundError extends Error {}

function isConstraintViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = (error as { code: unknown }).code;
  return code === "23505" || code === "23514" || code === "23503";
}

/** 監査 diff 用に値を要約（ads-actions と同方針、mediaUrl/caption は丸出ししない）。 */
function auditView(v: AdInput): Record<string, unknown> {
  return {
    scope: "school",
    mediaType: v.mediaType,
    durationSec: v.durationSec,
    captionFontScale: v.captionFontScale,
    displayOrder: v.displayOrder,
    hasLink: v.linkUrl !== null,
    hasCaption: v.caption !== null,
  };
}

/**
 * audit_log に 1 行追記。school_id は対象校。row_hash はトリガが計算。
 *
 * **system_admin は users テーブルに存在しない**（system_admins で別管理・テナント外）。
 * audit_log の `created_by` / `updated_by` は `users(id)` への FK（migration 0004）なので、
 * system_admin の uid を入れると **FK 違反 (23503)** になる（delete は再 throw で HTTP 500、
 * create はロールバックして誤った「競合」表示）＝これが 500 の直接原因。`actor_user_id`
 * 自体に物理 FK は無いが、RLS ポリシー（migration 0005）・他アクションとの整合のため同様に
 * null とし、本人は FK の無い `actor_identity_uid` に保持して追跡可能にする（view-audit.ts と同方針）。
 */
async function writeAudit(
  tx: TenantTx,
  params: {
    actor: { uid: string; role: string };
    schoolId: string;
    recordId: string;
    operation: "insert" | "delete";
    diff: unknown;
  },
): Promise<void> {
  const isSystemAdmin = params.actor.role === "system_admin";
  const actorRef = isSystemAdmin ? null : params.actor.uid;
  await tx.insert(auditLog).values({
    actorUserId: actorRef,
    actorIdentityUid: params.actor.uid,
    schoolId: params.schoolId,
    tableName: "ads",
    recordId: params.recordId,
    operation: params.operation,
    diff: params.diff as object,
    rowHash: "",
    createdBy: actorRef,
    updatedBy: actorRef,
  });
}

/** 広告主に紐づく学校スコープ広告を 1 件作成する（運営入稿）。 */
export async function createOperatorAdAction(raw: {
  advertiserId?: unknown;
  schoolId?: unknown;
  mediaUrl?: unknown;
  mediaType?: unknown;
  durationSec?: unknown;
  linkUrl?: unknown;
  caption?: unknown;
  captionFontScale?: unknown;
  displayOrder?: unknown;
}): Promise<ActionResult<{ id: string }>> {
  if (!isUuid(raw.advertiserId)) {
    return invalid("広告主の指定が不正です。");
  }
  if (!isUuid(raw.schoolId)) {
    return invalid("学校の指定が不正です。");
  }
  const advertiserId = raw.advertiserId;
  const schoolId = raw.schoolId;
  const v = validateAdInput(raw);
  if (!v.ok) {
    return invalid(v.message);
  }
  const user = await requireRole(SYSTEM_ADMIN_ROLES);

  try {
    const data = await withSession(async (tx) => {
      // 広告主・学校の実在を確認（system_admin は全校/全広告主可視）。
      if (!(await getAdvertiserDetail(tx, advertiserId))) {
        throw new NotFoundError("指定された広告主が見つかりません。");
      }
      if (!(await getSchoolDetail(tx, schoolId))) {
        throw new NotFoundError("指定された学校が見つかりません。");
      }
      const [row] = await tx
        .insert(ads)
        .values({
          schoolId,
          scope: "school",
          advertiserId,
          mediaUrl: v.value.mediaUrl,
          mediaType: v.value.mediaType,
          durationSec: v.value.durationSec,
          linkUrl: v.value.linkUrl,
          caption: v.value.caption,
          captionFontScale: v.value.captionFontScale,
          displayOrder: v.value.displayOrder,
          createdBy: user.uid,
          updatedBy: user.uid,
        })
        .returning({ id: ads.id });
      const newId = row?.id;
      if (!newId) {
        throw new NotFoundError("広告の作成に失敗しました。");
      }
      await writeAudit(tx, {
        actor: user,
        schoolId,
        recordId: newId,
        operation: "insert",
        diff: { after: auditView(v.value) },
      });
      return { id: newId };
    });
    revalidatePath(`/ops/advertisers/${advertiserId}/ads`);
    revalidatePath("/app/signage-preview/[classId]", "page");
    return { ok: true, data };
  } catch (error) {
    if (error instanceof NotFoundError) {
      return notFound(error.message);
    }
    if (isConstraintViolation(error)) {
      return conflict("他の操作と競合しました。最新の内容を読み込み直してください。");
    }
    throw error;
  }
}

/** 運営入稿広告（`advertiser_id` 有り）を 1 件削除する。学校のクラス広告（紐付け無し）は対象外。 */
export async function deleteOperatorAdAction(
  rawAdId: unknown,
): Promise<ActionResult<{ id: string }>> {
  if (!isUuid(rawAdId)) {
    return invalid("広告の指定が不正です。");
  }
  const adId = rawAdId;
  const user = await requireRole(SYSTEM_ADMIN_ROLES);

  try {
    const result = await withSession(async (tx) => {
      // 運営広告 (advertiser_id NOT NULL) のみ対象。学校のクラス広告 (null) は本サーフェスで消さない。
      const [target] = await tx
        .select({ id: ads.id, schoolId: ads.schoolId, advertiserId: ads.advertiserId })
        .from(ads)
        .where(and(eq(ads.id, adId), isNotNull(ads.advertiserId)))
        .limit(1);
      if (!target?.advertiserId) {
        throw new NotFoundError("広告が見つかりません。");
      }
      await tx.delete(ads).where(and(eq(ads.id, adId), isNotNull(ads.advertiserId)));
      await writeAudit(tx, {
        actor: user,
        schoolId: target.schoolId,
        recordId: adId,
        operation: "delete",
        diff: { before: { advertiserId: target.advertiserId } },
      });
      return { id: adId, advertiserId: target.advertiserId };
    });
    revalidatePath(`/ops/advertisers/${result.advertiserId}/ads`);
    revalidatePath("/app/signage-preview/[classId]", "page");
    return { ok: true, data: { id: result.id } };
  } catch (error) {
    if (error instanceof NotFoundError) {
      return notFound(error.message);
    }
    // create と対称に制約違反を握って意味あるメッセージに（本番マスクの 500 を防ぐ）。
    if (isConstraintViolation(error)) {
      return conflict("他の操作と競合しました。最新の内容を読み込み直してください。");
    }
    throw error;
  }
}
