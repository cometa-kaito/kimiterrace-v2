"use server";

import { type TenantTx, auditLog, classes, departments, grades } from "@kimiterrace/db";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireRole } from "../auth/guard";
import { withSession } from "../db";
import {
  type ActionResult,
  type HubActor,
  SCHOOL_HIERARCHY_ROLES,
  conflict,
  forbidden,
  invalid,
  toHubActor,
  validateClassInput,
  validateDepartmentInput,
  validateGradeInput,
} from "./hub-core";

/**
 * 学校管理者ハブの Server Actions (#48-K、ADR-008 — 画面 mutation は Server Actions)。
 *
 * 各操作: 入力検証 → 認可 (`requireRole`) → actor 解決 → `withSession` の自校 RLS tx 内で
 * 挿入 + `audit_log` 追記 → `revalidatePath`。set_config は手書きせず withSession に委譲 (ADR-019)。
 *
 * **多層防御 (cross-tenant 整合, Issue #73)**: 親参照 (grade.department_id / class.grade_id) は、
 * 挿入前に**自校で可視か RLS 経由で確認**してから結線する。RLS は SELECT を自校に限定するため、
 * 他校の id を渡しても「不可視 → not found」で弾かれ、別テナント行に子をぶら下げられない。
 */

/** 親参照が自校で不可視のときに tx をロールバックさせるための内部エラー (cross-tenant 防止)。 */
class CrossTenantError extends Error {}

/** PostgreSQL の unique 制約違反 (SQLSTATE 23505)。同名 (ux_*_school_name) の重複登録など。 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "23505"
  );
}

/**
 * create 系の共通後処理: 自校 tx で `build` を実行 → `/admin/school` を revalidate →
 * 統一エラー写像。CrossTenantError → invalid、unique 違反 → conflict (同名 500 化を防ぐ)、
 * それ以外は再 throw (想定外は握り潰さない)。
 */
async function finishCreate(
  build: (tx: TenantTx) => Promise<string>,
  conflictMessage: string,
): Promise<ActionResult<{ id: string }>> {
  try {
    const id = await withSession(build);
    revalidatePath("/admin/school");
    return { ok: true, data: { id } };
  } catch (error) {
    if (error instanceof CrossTenantError) {
      return invalid(error.message);
    }
    if (isUniqueViolation(error)) {
      return conflict(conflictMessage);
    }
    throw error;
  }
}

/** audit_log に 1 行追記 (ルール1 / NFR04)。prev_hash/row_hash は BEFORE INSERT トリガが計算。 */
async function writeAudit(
  tx: TenantTx,
  actor: HubActor,
  params: { tableName: string; recordId: string; after: unknown },
): Promise<void> {
  await tx.insert(auditLog).values({
    actorUserId: actor.userId,
    schoolId: actor.schoolId,
    tableName: params.tableName,
    recordId: params.recordId,
    operation: "insert",
    diff: { after: params.after } as object,
    rowHash: "",
    createdBy: actor.userId,
    updatedBy: actor.userId,
  });
}

async function authorize(): Promise<HubActor | ActionResult<never>> {
  const user = await requireRole(SCHOOL_HIERARCHY_ROLES);
  const actor = toHubActor(user);
  if (!actor) {
    return forbidden("学校に属さないユーザーは階層を編集できません。");
  }
  return actor;
}

/** 自校で可視な id か RLS 経由で確認する (他校 / 不存在は false)。 */
async function existsInSchool(
  tx: TenantTx,
  table: typeof grades | typeof departments,
  id: string,
): Promise<boolean> {
  const row = await tx.select({ id: table.id }).from(table).where(eq(table.id, id)).limit(1);
  return row.length > 0;
}

/** 学科を作成する。 */
export async function createDepartmentAction(raw: {
  name?: unknown;
  displayOrder?: unknown;
}): Promise<ActionResult<{ id: string }>> {
  const v = validateDepartmentInput(raw);
  if (!v.ok) {
    return invalid(v.message);
  }
  const actor = await authorize();
  if ("ok" in actor) {
    return actor;
  }

  return finishCreate(async (tx) => {
    const [row] = await tx
      .insert(departments)
      .values({
        schoolId: actor.schoolId,
        name: v.value.name,
        displayOrder: v.value.displayOrder,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      })
      .returning({ id: departments.id });
    const newId = row?.id as string;
    await writeAudit(tx, actor, { tableName: "departments", recordId: newId, after: v.value });
    return newId;
  }, "同名の学科が既に存在します。");
}

/** 学年を作成する。departmentId 指定時は自校の学科か確認してから結線。 */
export async function createGradeAction(raw: {
  name?: unknown;
  displayOrder?: unknown;
  hasClasses?: unknown;
  departmentId?: unknown;
}): Promise<ActionResult<{ id: string }>> {
  const v = validateGradeInput(raw);
  if (!v.ok) {
    return invalid(v.message);
  }
  const actor = await authorize();
  if ("ok" in actor) {
    return actor;
  }

  return finishCreate(async (tx) => {
    if (v.value.departmentId && !(await existsInSchool(tx, departments, v.value.departmentId))) {
      throw new CrossTenantError("指定された学科が見つかりません。");
    }
    const [row] = await tx
      .insert(grades)
      .values({
        schoolId: actor.schoolId,
        departmentId: v.value.departmentId,
        name: v.value.name,
        displayOrder: v.value.displayOrder,
        hasClasses: v.value.hasClasses,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      })
      .returning({ id: grades.id });
    const newId = row?.id as string;
    await writeAudit(tx, actor, { tableName: "grades", recordId: newId, after: v.value });
    return newId;
  }, "同名の学年が既に存在します。");
}

/** クラスを作成する。gradeId が自校の学年か確認してから結線。 */
export async function createClassAction(raw: {
  gradeId?: unknown;
  name?: unknown;
  academicYear?: unknown;
  grade?: unknown;
}): Promise<ActionResult<{ id: string }>> {
  const v = validateClassInput(raw);
  if (!v.ok) {
    return invalid(v.message);
  }
  const actor = await authorize();
  if ("ok" in actor) {
    return actor;
  }

  return finishCreate(async (tx) => {
    if (!(await existsInSchool(tx, grades, v.value.gradeId))) {
      throw new CrossTenantError("指定された学年が見つかりません。");
    }
    const [row] = await tx
      .insert(classes)
      .values({
        schoolId: actor.schoolId,
        gradeId: v.value.gradeId,
        name: v.value.name,
        academicYear: v.value.academicYear,
        grade: v.value.grade,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      })
      .returning({ id: classes.id });
    const newId = row?.id as string;
    await writeAudit(tx, actor, { tableName: "classes", recordId: newId, after: v.value });
    return newId;
  }, "同名のクラスが既に存在します。");
}
