"use server";

import { type TenantTx, ads, auditLog, findOwnAd, findVisibleTarget } from "@kimiterrace/db";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireRole } from "../auth/guard";
import { withSession } from "../db";
import { type EditorTarget, parseEditorTarget, targetIdColumns } from "../editor/schedule-core";
import {
  ADS_ROLES,
  type ActionResult,
  type AdInput,
  type AdsActor,
  conflict,
  forbidden,
  invalid,
  isUuid,
  notFound,
  toAdsActor,
  validateAdInput,
} from "./ads-core";

/**
 * クラススコープ広告の Server Actions (#48-J、ADR-008 — 画面 mutation は Server Actions)。
 *
 * 各操作: 入力検証 → 認可 (`requireRole(ADS_ROLES)`) → actor 解決 → `withSession` の自校 RLS tx 内で
 * mutation + `audit_log` 追記 → `revalidatePath`。set_config は手書きせず withSession に委譲 (ADR-019)。
 *
 * **多層防御 (cross-tenant 整合, Issue #73)**: `classId` は書き込み前に **自校で可視か RLS 経由で
 * 確認** してから結線する (`findVisibleClass`)。RLS は SELECT を自校に限定するため、他校の class_id を
 * 渡しても「不可視 → not found」で弾かれ、別テナントのクラスに広告をぶら下げられない。
 * update / delete も対象 ad を **自クラススコープ + 自校可視** で再取得してから操作する
 * (RLS の WHERE 強制に加え、scope='class' 以外の継承広告 (school/grade/department) は編集不可)。
 *
 * 親階層から継承される広告 (scope ≠ class) の読み取りは `effective_ads_per_class` VIEW を使い、
 * 本 Server Action は **自クラススコープ広告のみ** を mutate する (継承分は read-only)。
 */

/** 親参照 (class) が自校で不可視のとき tx をロールバックさせる内部エラー (cross-tenant 防止)。 */
class CrossTenantError extends Error {}
/** 対象広告が自校・自クラススコープに存在しないとき tx をロールバックさせる内部エラー。 */
class AdNotFoundError extends Error {}

/** PostgreSQL の unique / check 制約違反 (SQLSTATE 23505 / 23514)。並行登録や制約違反など。 */
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
  actor: AdsActor,
  params: {
    recordId: string;
    operation: "insert" | "update" | "delete";
    diff: unknown;
  },
): Promise<void> {
  await tx.insert(auditLog).values({
    actorUserId: actor.userId,
    schoolId: actor.schoolId,
    tableName: "ads",
    recordId: params.recordId,
    operation: params.operation,
    diff: params.diff as object,
    rowHash: "",
    createdBy: actor.userId,
    updatedBy: actor.userId,
  });
}

/** 認可 + actor 解決。teacher / テナント未選択は forbidden。 */
async function authorize(): Promise<AdsActor | ActionResult<never>> {
  const user = await requireRole(ADS_ROLES);
  const actor = toAdsActor(user);
  if (!actor) {
    return forbidden("学校に属さないユーザーは広告を編集できません。");
  }
  return actor;
}

/** target に対応する広告管理ページのパス (revalidate 用)。class は従来の /app/editor/{id}/ads。 */
function adsPath(target: EditorTarget): string {
  switch (target.scope) {
    case "school":
      return "/app/editor/scope/school/ads";
    case "department":
      return `/app/editor/scope/department/${target.departmentId}/ads`;
    case "grade":
      return `/app/editor/scope/grade/${target.gradeId}/ads`;
    case "class":
      return `/app/editor/${target.classId}/ads`;
  }
}

/** mutation の共通後処理: 自校 tx 実行 → 関連パス revalidate → 統一エラー写像。 */
async function finish<T>(
  target: EditorTarget,
  build: (tx: TenantTx) => Promise<T>,
): Promise<ActionResult<T>> {
  try {
    // tenantScoped: system_admin を school_admin に降格し system_admin_full_access policy の全校発火を
    // 止める (ADR-019 §#95 / Issue #197)。本 Action は特定 scope = 特定 school のテナントスコープ書込で、
    // これが無いと schoolId claim を持つ system_admin の findVisibleTarget が他校の 学科/学年 を可視と
    // 判定し、別テナントの grade_id/department_id を参照する広告を作れてしまう (cross-tenant write)。
    const data = await withSession(build, { tenantScoped: true });
    revalidatePath(adsPath(target));
    // サイネージ (#48-E1) も即時反映 (F04 即公開と同思想)。親階層 (学校/学科/学年) 広告は配下全クラスに
    // 継承表示されるため、動的 signage-preview ページ全体を revalidate する。
    revalidatePath("/app/signage-preview/[classId]", "page");
    return { ok: true, data };
  } catch (error) {
    if (error instanceof CrossTenantError) {
      return invalid(error.message);
    }
    if (error instanceof AdNotFoundError) {
      return notFound("広告が見つかりません。");
    }
    if (isConstraintViolation(error)) {
      return conflict("他の操作と競合しました。最新の内容を読み込み直してください。");
    }
    throw error;
  }
}

/** caption / mediaUrl をログに丸出ししないため、監査 diff 用に値を要約する。 */
function auditView(value: AdInput): Record<string, unknown> {
  return {
    mediaType: value.mediaType,
    durationSec: value.durationSec,
    captionFontScale: value.captionFontScale,
    displayOrder: value.displayOrder,
    hasLink: value.linkUrl !== null,
    hasCaption: value.caption !== null,
  };
}

/** 指定スコープ (学校全体 / 学科 / 学年 / クラス) に自スコープ広告を 1 件作成する。 */
export async function createAdAction(
  rawScope: unknown,
  rawTargetId: unknown,
  raw: Parameters<typeof validateAdInput>[0],
): Promise<ActionResult<{ id: string }>> {
  const target = parseEditorTarget(rawScope, rawTargetId);
  if (!target) {
    return invalid("編集対象 (スコープ) の指定が不正です。");
  }
  const v = validateAdInput(raw ?? {});
  if (!v.ok) {
    return invalid(v.message);
  }
  const actor = await authorize();
  if ("ok" in actor) {
    return actor;
  }
  const cols = targetIdColumns(target);

  return finish(target, async (tx) => {
    // 対象 (学科/学年/クラス) が自校で可視か (他校 id は RLS で不可視 → CrossTenantError)。
    if (!(await findVisibleTarget(tx, cols))) {
      throw new CrossTenantError("指定された編集対象が見つかりません。");
    }
    const [row] = await tx
      .insert(ads)
      .values({
        schoolId: actor.schoolId,
        scope: cols.scope,
        gradeId: cols.gradeId,
        departmentId: cols.departmentId,
        classId: cols.classId,
        mediaUrl: v.value.mediaUrl,
        mediaType: v.value.mediaType,
        durationSec: v.value.durationSec,
        linkUrl: v.value.linkUrl,
        caption: v.value.caption,
        captionFontScale: v.value.captionFontScale,
        displayOrder: v.value.displayOrder,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      })
      .returning({ id: ads.id });
    const newId = row?.id;
    if (!newId) {
      throw new AdNotFoundError();
    }
    await writeAudit(tx, actor, {
      recordId: newId,
      operation: "insert",
      diff: { after: auditView(v.value) },
    });
    return { id: newId };
  });
}

/** 指定スコープの自スコープ広告 1 件を更新する。 */
export async function updateAdAction(
  rawScope: unknown,
  rawTargetId: unknown,
  rawAdId: unknown,
  raw: Parameters<typeof validateAdInput>[0],
): Promise<ActionResult<{ id: string }>> {
  const target = parseEditorTarget(rawScope, rawTargetId);
  if (!target) {
    return invalid("編集対象 (スコープ) の指定が不正です。");
  }
  if (!isUuid(rawAdId)) {
    return invalid("広告の指定が不正です。");
  }
  const adId = rawAdId;
  const v = validateAdInput(raw ?? {});
  if (!v.ok) {
    return invalid(v.message);
  }
  const actor = await authorize();
  if ("ok" in actor) {
    return actor;
  }
  const cols = targetIdColumns(target);

  return finish(target, async (tx) => {
    // 対象広告を「id + 同一スコープ・同一ターゲット」で取得 (継承広告・他校・他対象は弾く)。
    const existing = await findOwnAd(tx, adId, cols);
    if (!existing) {
      throw new AdNotFoundError();
    }
    await tx
      .update(ads)
      .set({
        mediaUrl: v.value.mediaUrl,
        mediaType: v.value.mediaType,
        durationSec: v.value.durationSec,
        linkUrl: v.value.linkUrl,
        caption: v.value.caption,
        captionFontScale: v.value.captionFontScale,
        displayOrder: v.value.displayOrder,
        updatedBy: actor.userId,
        updatedAt: new Date(),
      })
      // RLS に加え scope を WHERE で二重に強制 (別スコープの行は更新不可)。
      .where(and(eq(ads.id, adId), eq(ads.scope, cols.scope)));
    await writeAudit(tx, actor, {
      recordId: adId,
      operation: "update",
      diff: {
        before: auditView({
          mediaUrl: existing.mediaUrl,
          mediaType: existing.mediaType,
          durationSec: existing.durationSec,
          linkUrl: existing.linkUrl,
          caption: existing.caption,
          captionFontScale: existing.captionFontScale,
          displayOrder: existing.displayOrder,
        }),
        after: auditView(v.value),
      },
    });
    return { id: adId };
  });
}

/** 指定スコープの自スコープ広告 1 件を削除する。 */
export async function deleteAdAction(
  rawScope: unknown,
  rawTargetId: unknown,
  rawAdId: unknown,
): Promise<ActionResult<{ id: string }>> {
  const target = parseEditorTarget(rawScope, rawTargetId);
  if (!target) {
    return invalid("編集対象 (スコープ) の指定が不正です。");
  }
  if (!isUuid(rawAdId)) {
    return invalid("広告の指定が不正です。");
  }
  const adId = rawAdId;
  const actor = await authorize();
  if ("ok" in actor) {
    return actor;
  }
  const cols = targetIdColumns(target);

  return finish(target, async (tx) => {
    const existing = await findOwnAd(tx, adId, cols);
    if (!existing) {
      throw new AdNotFoundError();
    }
    await tx.delete(ads).where(and(eq(ads.id, adId), eq(ads.scope, cols.scope)));
    await writeAudit(tx, actor, {
      recordId: adId,
      operation: "delete",
      diff: {
        before: auditView({
          mediaUrl: existing.mediaUrl,
          mediaType: existing.mediaType,
          durationSec: existing.durationSec,
          linkUrl: existing.linkUrl,
          caption: existing.caption,
          captionFontScale: existing.captionFontScale,
          displayOrder: existing.displayOrder,
        }),
      },
    });
    return { id: adId };
  });
}
