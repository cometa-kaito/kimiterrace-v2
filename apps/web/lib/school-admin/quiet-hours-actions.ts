"use server";

import {
  type TenantTx,
  auditLog,
  findVisibleTarget,
  getScopeConfigValue,
  upsertScopeConfig,
} from "@kimiterrace/db";
import { revalidatePath } from "next/cache";
import { requireRole } from "../auth/guard";
import { withSession } from "../db";
import { type EditorTarget, parseEditorTarget, targetIdColumns } from "../editor/schedule-core";
import {
  type ActionResult,
  QUIET_HOURS_KIND,
  QUIET_HOURS_ROLES,
  type QuietHoursActor,
  type QuietHoursValue,
  conflict,
  forbidden,
  invalid,
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
 * **system_admin の降格 (ADR-019 §#95 / Issue #226)**: 本 Action は特定 class (= 特定 school) を
 * 対象にするテナントスコープ操作のため、`withSession(..., { tenantScoped: true })` で実行する。
 * QUIET_HOURS_ROLES は system_admin を含むが、school_id claim を持つ system_admin の tx では
 * `system_admin_full_access` policy が全校発火し `findVisibleClass` が他校 class も可視と判定して
 * cross-tenant 越権が成立しうる (#197 の hub-actions と同種の gap)。tenantScoped で role を
 * school_admin に降格すると当該 policy が止まり、`tenant_isolation` だけが残るため他校 class は
 * 不可視になる。schoolId 無しの system_admin は降格されず toQuietHoursActor が null → forbidden。
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
    actorUserId: actor.actorUserId,
    actorIdentityUid: actor.identityUid,
    schoolId: actor.schoolId,
    tableName: "school_configs",
    recordId: params.recordId,
    operation: params.operation,
    diff: params.diff as object,
    rowHash: "",
    createdBy: actor.userRef,
    updatedBy: actor.userRef,
  });
}

/**
 * 認可 + actor 解決。teacher / テナント未選択は forbidden。`targetSchoolId` は **system_admin が
 * 特定校を対象にする経路** (/ops/schools/[id]/quiet-hours/[classId]) からのみ意味を持つ。tenant ロール
 * (school_admin) では `toQuietHoursActor` が無視し自校に固定する (越境防止)。system_admin で対象校
 * 未指定 / 不正なら forbidden。
 */
async function authorize(targetSchoolId?: string): Promise<QuietHoursActor | ActionResult<never>> {
  const user = await requireRole(QUIET_HOURS_ROLES);
  const actor = toQuietHoursActor(user, targetSchoolId);
  if (!actor) {
    return forbidden(
      user.role === "system_admin"
        ? "対象の学校が指定されていません。"
        : "学校に属さないユーザーは静粛時間を編集できません。",
    );
  }
  return actor;
}

/** 監査 diff 用: 時刻のみで PII を含まないが、件数と一覧を要約して残す。 */
function auditView(value: QuietHoursValue): Record<string, unknown> {
  return { count: value.ranges.length, ranges: value.ranges };
}

/** target に対応する静粛時間ページのパス (revalidate 用)。class は従来の /app/editor/{id}/quiet-hours。 */
function quietHoursPath(target: EditorTarget): string {
  switch (target.scope) {
    case "school":
      return "/app/editor/scope/school/quiet-hours";
    case "department":
      return `/app/editor/scope/department/${target.departmentId}/quiet-hours`;
    case "grade":
      return `/app/editor/scope/grade/${target.gradeId}/quiet-hours`;
    case "class":
      return `/app/editor/${target.classId}/quiet-hours`;
  }
}

/**
 * 指定スコープ (学校全体 / 学科 / 学年 / クラス) の静粛時間を設定する (upsert)。`ranges` 空配列で
 * 「静粛時間なし」に更新できる。親階層に設定すると配下クラスに継承表示される (effective-daily-data)。
 *
 * @param rawScope    "school" | "department" | "grade" | "class"
 * @param rawTargetId 対象 id (school は null)
 * @param rawRanges   時間帯配列 (`[{ start:"HH:MM", end:"HH:MM" }]`)
 */
export async function saveQuietHoursAction(
  rawScope: unknown,
  rawTargetId: unknown,
  rawRanges: unknown,
  targetSchoolId?: string,
): Promise<ActionResult<{ id: string }>> {
  const target = parseEditorTarget(rawScope, rawTargetId);
  if (!target) {
    return invalid("編集対象 (スコープ) の指定が不正です。");
  }
  const v = validateQuietHours(rawRanges);
  if (!v.ok) {
    return invalid(v.message);
  }
  const actor = await authorize(targetSchoolId);
  if ("ok" in actor) {
    return actor;
  }
  const cols = targetIdColumns(target);

  try {
    // tenantScoped: system_admin を school_admin に降格し full_access policy の全校発火を止める
    // (ADR-019 §#95 / Issue #226)。本 Action は特定 scope = 特定 school のテナントスコープ操作。
    // schoolId: school_admin は自校 (= 渡しても同値)、system_admin は対象校 (/ops 経路)。withSession 側で
    // 「system_admin のときだけ override を honor」するため tenant ロールは自校に固定される (越境防止)。
    const id = await withSession(
      async (tx) => {
        // 対象 (学科/学年/クラス) が自校で可視か (他校 id は RLS で不可視 → CrossTenantError)。
        if (!(await findVisibleTarget(tx, cols))) {
          throw new CrossTenantError("指定された編集対象が見つかりません。");
        }
        // upsert 前に既存値を読み、insert/update の別と before スナップショットを確定する。
        const prev = await getScopeConfigValue(tx, cols, QUIET_HOURS_KIND);
        const operation: "insert" | "update" = prev === null ? "insert" : "update";

        const newId = await upsertScopeConfig(tx, {
          schoolId: actor.schoolId,
          target: cols,
          kind: QUIET_HOURS_KIND,
          value: v.value,
          // created_by / updated_by は users.id への FK。system_admin は null (FK 回避、userRef)。
          actorUserId: actor.userRef,
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
      },
      { tenantScoped: true, schoolId: actor.schoolId },
    );

    revalidatePath(quietHoursPath(target));
    // system_admin の /ops 経路 (クラス静粛時間) も反映。school_admin の自校経路では当該パスは未使用だが無害。
    if (target.scope === "class") {
      revalidatePath(`/ops/schools/${actor.schoolId}/quiet-hours/${target.classId}`);
    }
    // サイネージ (#48-E1) も即時反映 (F04 即公開と同思想)。
    revalidatePath("/app/signage-preview/[classId]", "page");
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
