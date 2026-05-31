"use server";

import {
  type TenantTx,
  auditLog,
  findVisibleClass,
  getClassConfigValue,
  upsertClassConfig,
} from "@kimiterrace/db";
import { revalidatePath } from "next/cache";
import { requireRole } from "../auth/guard";
import { withSession } from "../db";
import {
  type ActionResult,
  QUIET_HOURS_KIND,
  QUIET_HOURS_ROLES,
  type QuietHoursActor,
  type QuietHoursValue,
  conflict,
  forbidden,
  invalid,
  isUuid,
  readQuietRanges,
  toQuietHoursActor,
  validateQuietHours,
} from "./quiet-hours-core";

/**
 * クラス設定「静粛時間 (quiet_hours)」の Server Action (#48-J-2、ADR-008 — 画面 mutation は Server Actions)。
 *
 * 操作: 入力検証 → 認可 (`requireRole(QUIET_HOURS_ROLES)`) → actor 解決 → `withSession` の自校 RLS tx 内で
 * **1 (school, class, kind) = 1 行の upsert** + `audit_log` 追記 → `revalidatePath`。
 * `school_configs` は手書き WHERE school_id を持たず、RLS (`tenant_isolation`) が自校を強制する (ルール2)。
 *
 * **多層防御 (cross-tenant 整合, Issue #73)**: `classId` は書き込み前に **自校で可視か RLS 経由で
 * 確認** してから結線する (`findVisibleClass`)。他校の class_id を渡しても「不可視 → not found」で弾かれ、
 * 別テナントのクラスに静粛時間をぶら下げられない。
 *
 * **value 構造 (読み取り契約との整合)**: signage (`effective-daily-data.ts`) は時間帯を配列として読むため、
 * value は `{ ranges: [{ start:"HH:MM", end:"HH:MM" }] }` のオブジェクトで保存する (quiet-hours-core.ts 参照)。
 */

/** 親参照 (class) が自校で不可視のとき tx をロールバックさせる内部エラー (cross-tenant 防止)。 */
class CrossTenantError extends Error {}

/** PostgreSQL の unique / check 制約違反 (SQLSTATE 23505 / 23514)。並行 upsert や制約違反など。 */
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
  actor: QuietHoursActor,
  params: {
    recordId: string;
    operation: "insert" | "update";
    diff: unknown;
  },
): Promise<void> {
  await tx.insert(auditLog).values({
    actorUserId: actor.userId,
    schoolId: actor.schoolId,
    tableName: "school_configs",
    recordId: params.recordId,
    operation: params.operation,
    diff: params.diff as object,
    rowHash: "",
    createdBy: actor.userId,
    updatedBy: actor.userId,
  });
}

/** 認可 + actor 解決。teacher / テナント未選択は forbidden。 */
async function authorize(): Promise<QuietHoursActor | ActionResult<never>> {
  const user = await requireRole(QUIET_HOURS_ROLES);
  const actor = toQuietHoursActor(user);
  if (!actor) {
    return forbidden("学校に属さないユーザーは静粛時間を編集できません。");
  }
  return actor;
}

/** 監査 diff 用: 時刻のみで PII を含まないが、件数と一覧を要約して残す。 */
function auditView(value: QuietHoursValue): Record<string, unknown> {
  return { count: value.ranges.length, ranges: value.ranges };
}

/**
 * 指定クラスの静粛時間を設定する (upsert)。`ranges` 空配列で「静粛時間なし」に更新できる。
 *
 * @param rawClassId 対象クラス id
 * @param rawRanges  時間帯配列 (`[{ start:"HH:MM", end:"HH:MM" }]`)
 */
export async function saveQuietHoursAction(
  rawClassId: unknown,
  rawRanges: unknown,
): Promise<ActionResult<{ id: string }>> {
  if (!isUuid(rawClassId)) {
    return invalid("クラスの指定が不正です。");
  }
  const classId = rawClassId;
  const v = validateQuietHours(rawRanges);
  if (!v.ok) {
    return invalid(v.message);
  }
  const actor = await authorize();
  if ("ok" in actor) {
    return actor;
  }

  try {
    const id = await withSession(async (tx) => {
      // 自校で可視なクラスか (他校 id は RLS で不可視 → CrossTenantError)。
      if (!(await findVisibleClass(tx, classId))) {
        throw new CrossTenantError("指定されたクラスが見つかりません。");
      }
      // upsert 前に既存値を読み、insert/update の別と before スナップショットを確定する。
      const prev = await getClassConfigValue(tx, classId, QUIET_HOURS_KIND);
      const operation: "insert" | "update" = prev === null ? "insert" : "update";

      const newId = await upsertClassConfig(tx, {
        schoolId: actor.schoolId,
        classId,
        kind: QUIET_HOURS_KIND,
        value: v.value,
        actorUserId: actor.userId,
      });
      if (!newId) {
        throw new CrossTenantError("静粛時間を保存できませんでした。");
      }

      await writeAudit(tx, actor, {
        recordId: newId,
        operation,
        diff:
          operation === "insert"
            ? { after: auditView(v.value) }
            : {
                before: { count: readQuietRanges(prev).length, ranges: readQuietRanges(prev) },
                after: auditView(v.value),
              },
      });
      return newId;
    });

    revalidatePath(`/admin/editor/${classId}/quiet-hours`);
    // サイネージ (#48-E1) も即時反映 (F04 即公開と同思想)。
    revalidatePath("/admin/signage-preview/[classId]", "page");
    return { ok: true, data: { id } };
  } catch (error) {
    if (error instanceof CrossTenantError) {
      return invalid(error.message);
    }
    if (isConstraintViolation(error)) {
      return conflict("他の操作と競合しました。最新の内容を読み込み直してください。");
    }
    throw error;
  }
}
