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
  nextDuplicationYears,
  notFound,
  planNextYearDuplication,
  toHubActor,
  validateClassInput,
  validateClassUpdate,
  validateDepartmentInput,
  validateDepartmentUpdate,
  validateGradeInput,
  validateGradeUpdate,
  validateId,
} from "./hub-core";
import {
  countClassesInGrade,
  countGradesInDepartment,
  getClassYearRows,
  getTargetYearClassKeys,
} from "./hub-queries";

/**
 * 学校管理者ハブの Server Actions (#48-K / #48-K2、ADR-008 — 画面 mutation は Server Actions)。
 *
 * 各操作: 入力検証 → 認可 (`requireRole`) → actor 解決 → `withSession` の自校 RLS tx 内で
 * mutation + `audit_log` 追記 → `revalidatePath`。set_config は手書きせず withSession に委譲 (ADR-019)。
 *
 * **多層防御 (cross-tenant 整合, Issue #73)**: 親参照 (grade.department_id / class.grade_id) は、
 * 書き込み前に**自校で可視か RLS 経由で確認**してから結線する。RLS は SELECT を自校に限定するため、
 * 他校の id を渡しても「不可視 → not found」で弾かれ、別テナント行に子をぶら下げられない。
 * これは create の親結線だけでなく、update の対象再取得・grade の department_id 付替先確認にも適用する。
 *
 * **system_admin の降格 (ADR-019 §#95 / Issue #197)**: 本ハブは常に特定 school を対象にする
 * テナントスコープ操作のため、`finish` は `withSession(..., { tenantScoped: true })` で実行する。
 * これにより actor が system_admin でも tx 内 role が school_admin に降格され、`system_admin_full_access`
 * policy の全校発火が止まる。結果、上記の自校可視性チェック (existsInSchool) は system_admin でも
 * 自校のみを可視と判定し、cross-tenant 付替が DB レベルで成立しなくなる (従来は full_access が効き
 * すり抜けていた)。全校横断が必要な system_admin 専用経路は tenantScoped を指定しない。
 *
 * **子参照ガード (#48-K2 delete)**: FK は `onDelete: "set null"` のため DB は削除を拒否せず子を
 * 孤児化する。階層が静かに壊れるのを防ぐため、削除前に子 (学科→学年 / 学年→クラス) の有無を
 * 自校 RLS tx で数え、残っていれば `conflict` で拒否する。
 */

/** 親参照が自校で不可視のときに tx をロールバックさせるための内部エラー (cross-tenant 防止)。 */
class CrossTenantError extends Error {}

/** 対象行が自校で見つからない (他校 / 不存在 / 既削除) ときに tx をロールバックさせる。 */
class HubNotFoundError extends Error {}

/** 子参照が残っているため削除できないときに tx をロールバックさせる (子参照ガード)。 */
class ChildExistsError extends Error {}

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
 * mutation の共通後処理: 自校 tx で `build` を実行 → `/admin/school` を revalidate →
 * 統一エラー写像。CrossTenantError → invalid、HubNotFoundError → not_found、
 * ChildExistsError → conflict、unique 違反 → conflict (同名 500 化を防ぐ)、
 * それ以外は再 throw (想定外は握り潰さない)。
 */
async function finish<T>(
  build: (tx: TenantTx) => Promise<T>,
  conflictMessage: string,
): Promise<ActionResult<T>> {
  try {
    // tenantScoped: system_admin を school_admin に降格し full_access policy の全校発火を止める
    // (ADR-019 §#95 / Issue #197)。ハブは常に特定 school を対象にするテナントスコープ操作。
    const data = await withSession(build, { tenantScoped: true });
    revalidatePath("/admin/school");
    return { ok: true, data };
  } catch (error) {
    if (error instanceof CrossTenantError) {
      return invalid(error.message);
    }
    if (error instanceof HubNotFoundError) {
      return notFound(error.message);
    }
    if (error instanceof ChildExistsError) {
      return conflict(error.message);
    }
    if (isUniqueViolation(error)) {
      return conflict(conflictMessage);
    }
    throw error;
  }
}

/** create 系の後処理 (id を返す形)。`finish` のラッパで型を `{ id: string }` に固定する。 */
function finishCreate(
  build: (tx: TenantTx) => Promise<string>,
  conflictMessage: string,
): Promise<ActionResult<{ id: string }>> {
  return finish(async (tx) => ({ id: await build(tx) }), conflictMessage);
}

/**
 * audit_log に 1 行追記 (ルール1 / NFR04)。prev_hash/row_hash は BEFORE INSERT トリガが計算。
 * operation で insert/update/delete を出し分け、update/delete は diff に before/after を残す。
 */
async function writeAudit(
  tx: TenantTx,
  actor: HubActor,
  params: {
    tableName: string;
    recordId: string;
    operation: "insert" | "update" | "delete";
    diff: unknown;
  },
): Promise<void> {
  await tx.insert(auditLog).values({
    actorUserId: actor.userId,
    schoolId: actor.schoolId,
    tableName: params.tableName,
    recordId: params.recordId,
    operation: params.operation,
    diff: params.diff as object,
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
  table: typeof grades | typeof departments | typeof classes,
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
    await writeAudit(tx, actor, {
      tableName: "departments",
      recordId: newId,
      operation: "insert",
      diff: { after: v.value },
    });
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
    await writeAudit(tx, actor, {
      tableName: "grades",
      recordId: newId,
      operation: "insert",
      diff: { after: v.value },
    });
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
    await writeAudit(tx, actor, {
      tableName: "classes",
      recordId: newId,
      operation: "insert",
      diff: { after: v.value },
    });
    return newId;
  }, "同名のクラスが既に存在します。");
}

/* ================================================================== *
 *  update (#48-K2)
 *
 *  全フィールド置換 + 監査 diff (before/after)。対象行は自校 RLS tx で再取得し、
 *  他校 / 不存在は HubNotFoundError → not_found。同名衝突は unique → conflict。
 * ================================================================== */

/** 学科をリネーム / 表示順変更する。 */
export async function updateDepartmentAction(raw: {
  id?: unknown;
  name?: unknown;
  displayOrder?: unknown;
}): Promise<ActionResult<{ id: string }>> {
  const v = validateDepartmentUpdate(raw);
  if (!v.ok) {
    return invalid(v.message);
  }
  const actor = await authorize();
  if ("ok" in actor) {
    return actor;
  }

  return finish(async (tx) => {
    const [before] = await tx
      .select({ name: departments.name, displayOrder: departments.displayOrder })
      .from(departments)
      .where(eq(departments.id, v.value.id))
      .limit(1);
    if (!before) {
      throw new HubNotFoundError("指定された学科が見つかりません。");
    }
    await tx
      .update(departments)
      .set({
        name: v.value.name,
        displayOrder: v.value.displayOrder,
        updatedBy: actor.userId,
        updatedAt: new Date(),
      })
      .where(eq(departments.id, v.value.id));
    await writeAudit(tx, actor, {
      tableName: "departments",
      recordId: v.value.id,
      operation: "update",
      diff: { before, after: { name: v.value.name, displayOrder: v.value.displayOrder } },
    });
    return { id: v.value.id };
  }, "同名の学科が既に存在します。");
}

/**
 * 学年をリネーム / 表示順・hasClasses 変更 / department_id 付替する。
 *
 * **付替先の cross-tenant 検証 (#73 / L-1)**: departmentId 指定時は付替先学科が**自校で可視か**
 * `existsInSchool` で確認する。RLS の `tenant_isolation` が SELECT を自校に限定するため、他校
 * department の id を渡しても不可視 → CrossTenantError で弾かれる。
 *
 * **system_admin も封じ済 (ADR-019 §#95 / Issue #197)**: 以前は role=system_admin の tx で
 * `system_admin_full_access` policy が全校発火し `existsInSchool` が他校も可視と判定するため
 * cross-tenant 付替が成立しえたが、本ハブは `finish` が `tenantScoped: true` で system_admin を
 * school_admin に降格するようになった (file header 参照)。降格後は full_access が効かず、付替先
 * 可視性チェックが自校のみを通すため system_admin でも cross-tenant 付替は不成立。
 */
export async function updateGradeAction(raw: {
  id?: unknown;
  name?: unknown;
  displayOrder?: unknown;
  hasClasses?: unknown;
  departmentId?: unknown;
}): Promise<ActionResult<{ id: string }>> {
  const v = validateGradeUpdate(raw);
  if (!v.ok) {
    return invalid(v.message);
  }
  const actor = await authorize();
  if ("ok" in actor) {
    return actor;
  }

  return finish(async (tx) => {
    const [before] = await tx
      .select({
        name: grades.name,
        displayOrder: grades.displayOrder,
        hasClasses: grades.hasClasses,
        departmentId: grades.departmentId,
      })
      .from(grades)
      .where(eq(grades.id, v.value.id))
      .limit(1);
    if (!before) {
      throw new HubNotFoundError("指定された学年が見つかりません。");
    }
    // 付替先 department が自校で可視か (他校 / 不存在は cross-tenant 拒否)。
    if (v.value.departmentId && !(await existsInSchool(tx, departments, v.value.departmentId))) {
      throw new CrossTenantError("指定された学科が見つかりません。");
    }
    await tx
      .update(grades)
      .set({
        name: v.value.name,
        displayOrder: v.value.displayOrder,
        hasClasses: v.value.hasClasses,
        departmentId: v.value.departmentId,
        updatedBy: actor.userId,
        updatedAt: new Date(),
      })
      .where(eq(grades.id, v.value.id));
    await writeAudit(tx, actor, {
      tableName: "grades",
      recordId: v.value.id,
      operation: "update",
      diff: {
        before,
        after: {
          name: v.value.name,
          displayOrder: v.value.displayOrder,
          hasClasses: v.value.hasClasses,
          departmentId: v.value.departmentId,
        },
      },
    });
    return { id: v.value.id };
  }, "同名の学年が既に存在します。");
}

/** クラスをリネーム / 年度・学年数を変更する (親学年の付替は scope 外、別 issue)。 */
export async function updateClassAction(raw: {
  id?: unknown;
  name?: unknown;
  academicYear?: unknown;
  grade?: unknown;
}): Promise<ActionResult<{ id: string }>> {
  const v = validateClassUpdate(raw);
  if (!v.ok) {
    return invalid(v.message);
  }
  const actor = await authorize();
  if ("ok" in actor) {
    return actor;
  }

  return finish(async (tx) => {
    const [before] = await tx
      .select({
        name: classes.name,
        academicYear: classes.academicYear,
        grade: classes.grade,
      })
      .from(classes)
      .where(eq(classes.id, v.value.id))
      .limit(1);
    if (!before) {
      throw new HubNotFoundError("指定されたクラスが見つかりません。");
    }
    await tx
      .update(classes)
      .set({
        name: v.value.name,
        academicYear: v.value.academicYear,
        grade: v.value.grade,
        updatedBy: actor.userId,
        updatedAt: new Date(),
      })
      .where(eq(classes.id, v.value.id));
    await writeAudit(tx, actor, {
      tableName: "classes",
      recordId: v.value.id,
      operation: "update",
      diff: {
        before,
        after: {
          name: v.value.name,
          academicYear: v.value.academicYear,
          grade: v.value.grade,
        },
      },
    });
    return { id: v.value.id };
  }, "同名のクラスが既に存在します。");
}

/* ================================================================== *
 *  delete (#48-K2)
 *
 *  子参照ガード: FK は set null のため DB は削除を許すが、子 (学科→学年 / 学年→クラス) が
 *  残っていれば ChildExistsError → conflict で拒否する。対象不存在は HubNotFoundError → not_found。
 * ================================================================== */

/** 学科を削除する。属する学年が 1 件でもあれば拒否 (先に学年の付替 / 削除が必要)。 */
export async function deleteDepartmentAction(
  rawId: unknown,
): Promise<ActionResult<{ id: string }>> {
  const v = validateId(rawId);
  if (!v.ok) {
    return invalid(v.message);
  }
  const actor = await authorize();
  if ("ok" in actor) {
    return actor;
  }

  return finish(async (tx) => {
    if (!(await existsInSchool(tx, departments, v.value.id))) {
      throw new HubNotFoundError("指定された学科が見つかりません。");
    }
    if ((await countGradesInDepartment(tx, v.value.id)) > 0) {
      throw new ChildExistsError(
        "この学科に属する学年があるため削除できません。先に学年を移動または削除してください。",
      );
    }
    await tx.delete(departments).where(eq(departments.id, v.value.id));
    await writeAudit(tx, actor, {
      tableName: "departments",
      recordId: v.value.id,
      operation: "delete",
      diff: { before: { id: v.value.id } },
    });
    return { id: v.value.id };
  }, "削除に失敗しました。");
}

/** 学年を削除する。属するクラスが 1 件でもあれば拒否 (先にクラスの付替 / 削除が必要)。 */
export async function deleteGradeAction(rawId: unknown): Promise<ActionResult<{ id: string }>> {
  const v = validateId(rawId);
  if (!v.ok) {
    return invalid(v.message);
  }
  const actor = await authorize();
  if ("ok" in actor) {
    return actor;
  }

  return finish(async (tx) => {
    if (!(await existsInSchool(tx, grades, v.value.id))) {
      throw new HubNotFoundError("指定された学年が見つかりません。");
    }
    if ((await countClassesInGrade(tx, v.value.id)) > 0) {
      throw new ChildExistsError(
        "この学年に属するクラスがあるため削除できません。先にクラスを移動または削除してください。",
      );
    }
    await tx.delete(grades).where(eq(grades.id, v.value.id));
    await writeAudit(tx, actor, {
      tableName: "grades",
      recordId: v.value.id,
      operation: "delete",
      diff: { before: { id: v.value.id } },
    });
    return { id: v.value.id };
  }, "削除に失敗しました。");
}

/** クラスを削除する。クラスは階層の末端のため子参照ガードは不要。 */
export async function deleteClassAction(rawId: unknown): Promise<ActionResult<{ id: string }>> {
  const v = validateId(rawId);
  if (!v.ok) {
    return invalid(v.message);
  }
  const actor = await authorize();
  if ("ok" in actor) {
    return actor;
  }

  return finish(async (tx) => {
    if (!(await existsInSchool(tx, classes, v.value.id))) {
      throw new HubNotFoundError("指定されたクラスが見つかりません。");
    }
    await tx.delete(classes).where(eq(classes.id, v.value.id));
    await writeAudit(tx, actor, {
      tableName: "classes",
      recordId: v.value.id,
      operation: "delete",
      diff: { before: { id: v.value.id } },
    });
    return { id: v.value.id };
  }, "削除に失敗しました。");
}

/* ================================================================== *
 *  新年度へ複製 (#48-K3 PR3)
 *
 *  現在の最新年度のクラス群を翌年度の空クラスとして複製する (予定/公開内容は複製しない)。
 *  対象算出は純関数 planNextYearDuplication (hub-core)。source は常に最新年度ゆえ実行のたびに 1 年進む
 *  (冪等ではない・target は常に未存在年度)。各 insert を監査 (ルール1)・自校 RLS tx (ルール2)。
 *
 *  並行実行/別タブ再実行による翌年度クラスの重複生成は二段で防ぐ:
 *    1. DB: 部分 unique index ux_classes_school_year_grade_name が (school,year,grade,name) を直列化する
 *       (恒久ガード)。競合 insert は 23505 → finish の conflict 写像で graceful に返る。
 *    2. app: insert 直前に target 年度の既存クラス (getTargetYearClassKeys) を自校 RLS tx 内で取得し、
 *       planNextYearDuplication で除外する。先行 tx のコミットを観測できた場合に 23505 を避け graceful に
 *       skip する防御 (観測できない phantom race は 1 の index が倒す)。
 *  単一操作の二重押下は UI のボタン無効化でも抑止し、対象年度は確認モーダルで明示する。
 * ================================================================== */

/** 現年度のクラスを翌年度へ複製する。複製できるクラスが無ければ not_found。 */
export async function duplicateClassesToNextYearAction(): Promise<
  ActionResult<{ created: number; targetYear: number }>
> {
  const actor = await authorize();
  if ("ok" in actor) {
    return actor;
  }

  return finish(async (tx) => {
    const rows = await getClassYearRows(tx);
    const years = nextDuplicationYears(rows);
    if (!years) {
      throw new HubNotFoundError("複製できるクラスがありません。");
    }
    // target 年度の既存クラスを insert 直前に取得し除外する (並行コミットを観測できた場合の graceful skip)。
    const existingTarget = await getTargetYearClassKeys(tx, years.targetYear);
    const plan = planNextYearDuplication(rows, existingTarget);
    if (!plan) {
      throw new HubNotFoundError("複製できるクラスがありません。");
    }
    for (const c of plan.toCreate) {
      const [row] = await tx
        .insert(classes)
        .values({
          schoolId: actor.schoolId,
          gradeId: c.gradeId,
          name: c.name,
          academicYear: c.academicYear,
          grade: c.grade,
          createdBy: actor.userId,
          updatedBy: actor.userId,
        })
        .returning({ id: classes.id });
      await writeAudit(tx, actor, {
        tableName: "classes",
        recordId: row?.id as string,
        operation: "insert",
        diff: { after: c, reason: "duplicate-next-year" },
      });
    }
    return { created: plan.toCreate.length, targetYear: plan.targetYear };
  }, "新年度への複製に失敗しました。");
}
