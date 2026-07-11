"use server";

import { type TenantTx, auditLog, getSchoolConfigValue, upsertSchoolConfig } from "@kimiterrace/db";
import { revalidatePath } from "next/cache";
import { requireRole } from "../auth/guard";
import { withSession } from "../db";
import { isPgErrorCode } from "../pg-error";
import {
  type AssignmentDeadlineFormat,
  isAssignmentDeadlineFormat,
  parseAssignmentDeadlineFormat,
} from "../signage/assignment-deadline-format";
import {
  type ActionResult,
  type HubActor,
  SCHOOL_HIERARCHY_ROLES,
  conflict,
  forbidden,
  invalid,
  toHubActor,
} from "./hub-core";

/**
 * 学校スコープ「サイネージ表示設定 (display_settings)」の Server Action（#1258・ADR-008 — 画面 mutation は
 * Server Actions）。自校の `school_configs`（scope='school', kind='display_settings'）の
 * `value.assignmentDeadlineFormat`（提出物の期日表示形式）を upsert する。
 *
 * 操作: 入力検証 → 認可（`requireRole(SCHOOL_HIERARCHY_ROLES)`）→ actor 解決 →
 * `withSession({ tenantScoped: true })` の自校 RLS tx 内で **1 (school, 'school', display_settings) = 1 行の
 * upsert** + `audit_log` 追記 → `revalidatePath`。`school_configs` は手書き WHERE school_id を持たず、
 * RLS（`tenant_isolation`）が自校を強制する（ルール2）。
 *
 * **既存キーの保全（マージ upsert）**: 同じ scope='school' の display_settings 行には `signageDesign`
 * （学校既定デザイン）/ `editorDayCutover`（エディタ既定対象日の切替時刻）が相乗りしている。upsert は
 * value 全置換のため、**既存 value を読んでスプレッドした上で本キーだけ差し替える**（他キーを消さない）。
 *
 * **school_admin 専任**: 学校レベルの表示設定は自校の school_admin が変える運用。system_admin は
 * `toHubActor` が対象校未指定で null → forbidden（全校横断の生 JSON 編集は /ops/school-configs が既存導線）。
 */

/** 親スコープの検証不能等で tx をロールバックさせる内部エラー。 */
class SaveFailedError extends Error {}

/** PostgreSQL の unique / check 制約違反（SQLSTATE 23505 / 23514）。並行 upsert など。 */
function isConstraintViolation(error: unknown): boolean {
  return isPgErrorCode(error, "23505", "23514");
}

/** audit_log に 1 行追記（ルール1 / NFR04）。値は表示形式の識別子のみで PII を含まない。 */
async function writeAudit(
  tx: TenantTx,
  actor: HubActor,
  params: {
    recordId: string;
    operation: "insert" | "update";
    before: AssignmentDeadlineFormat;
    after: AssignmentDeadlineFormat;
  },
): Promise<void> {
  await tx.insert(auditLog).values({
    actorUserId: actor.actorUserId,
    actorIdentityUid: actor.identityUid,
    schoolId: actor.schoolId,
    tableName: "school_configs",
    recordId: params.recordId,
    operation: params.operation,
    diff:
      params.operation === "insert"
        ? { after: { assignmentDeadlineFormat: params.after } }
        : {
            before: { assignmentDeadlineFormat: params.before },
            after: { assignmentDeadlineFormat: params.after },
          },
    rowHash: "",
    createdBy: actor.userRef,
    updatedBy: actor.userRef,
  });
}

/**
 * 自校のサイネージ「提出物の期日表示形式」を設定する（upsert・#1258）。
 *
 * @param rawFormat "daysLeft"（残り日数・既定）| "until"（M/Dまで）。それ以外は invalid。
 */
export async function saveAssignmentDeadlineFormatAction(
  rawFormat: unknown,
): Promise<ActionResult<{ format: AssignmentDeadlineFormat }>> {
  if (!isAssignmentDeadlineFormat(rawFormat)) {
    return invalid("期日表示形式の指定が不正です。");
  }

  const user = await requireRole(SCHOOL_HIERARCHY_ROLES);
  const actor = toHubActor(user);
  // 本設定は自校運用（school_admin）専任。system_admin は actor 解決不能（対象校未指定）→ forbidden。
  if (!actor || actor.userRef === null) {
    return forbidden("学校に属する学校管理者のみ表示設定を変更できます。");
  }
  const actorUserId = actor.userRef;

  try {
    const saved = await withSession(
      async (tx) => {
        // upsert 前に既存値を読み、(1) insert/update の別と before スナップショット、(2) 相乗りキー
        // （signageDesign / editorDayCutover 等）を保全するマージ基底、を確定する。
        const prev = await getSchoolConfigValue(tx, "display_settings");
        const operation: "insert" | "update" = prev === null ? "insert" : "update";
        const before = parseAssignmentDeadlineFormat(prev);
        const base =
          prev && typeof prev === "object" && !Array.isArray(prev)
            ? (prev as Record<string, unknown>)
            : {};

        const id = await upsertSchoolConfig(tx, {
          schoolId: actor.schoolId,
          kind: "display_settings",
          value: { ...base, assignmentDeadlineFormat: rawFormat },
          actorUserId,
        });
        if (!id) {
          throw new SaveFailedError("表示設定を保存できませんでした。");
        }

        await writeAudit(tx, actor, { recordId: id, operation, before, after: rawFormat });
        return rawFormat;
      },
      // tenantScoped: system_admin の full_access policy の全校発火を止める既存規律（quiet-hours と同作法）。
      // 本 Action は上で school_admin に絞っているが、多層防御として同じ形に揃える。
      { tenantScoped: true },
    );

    // 学校管理ハブ（設定 UI）と教員向けプレビュー導線を即時反映。実機サイネージは自前ポーリングで追従する。
    revalidatePath("/app/school");
    revalidatePath("/app/signage-preview/[classId]", "page");
    return { ok: true, data: { format: saved } };
  } catch (error) {
    if (error instanceof SaveFailedError) {
      return invalid(error.message);
    }
    if (isConstraintViolation(error)) {
      return conflict("他の操作と競合しました。最新の内容を読み込み直してください。");
    }
    throw error;
  }
}
