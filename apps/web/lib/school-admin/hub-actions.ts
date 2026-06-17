"use server";

import { type TenantTx, auditLog, classes, departments, grades } from "@kimiterrace/db";
import { and, eq, isNull, ne } from "drizzle-orm";
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
  notFound,
  toHubActor,
  validateClassInput,
  validateClassUpdate,
  validateDepartmentInput,
  validateDepartmentUpdate,
  validateGradeInput,
  validateGradeUpdate,
  validateId,
  validateOtherLocationInput,
  validateOtherLocationUpdate,
  validateReorder,
} from "./hub-core";
import { countClassesInGrade, countGradesInDepartment } from "./hub-queries";

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
 * テナントスコープ操作のため、`finish` は `withSession(..., { tenantScoped: true, schoolId })` で実行する。
 * これにより actor が system_admin でも tx 内 role が school_admin に降格され、`system_admin_full_access`
 * policy の全校発火が止まる。結果、上記の自校可視性チェック (existsInSchool) は system_admin でも
 * 自校のみを可視と判定し、cross-tenant 付替が DB レベルで成立しなくなる (従来は full_access が効き
 * すり抜けていた)。全校横断が必要な system_admin 専用経路は tenantScoped を指定しない。
 *
 * **対象校 (school_admin=自校 / system_admin=明示)**: 各 action は任意の `targetSchoolId` を取る。
 * school_admin は自校に固定 (引数を無視、従来と完全同一)、system_admin は /ops/schools/[id]/hierarchy
 * から対象校 id を受け取りそこへスコープする (`toHubActor` / `withSession` が role でゲートし越境を防ぐ)。
 *
 * **監査 actor (ルール1 / system_admin は users 表に行が無い)**: `writeAudit` と各 insert は
 * `HubActor.userRef` を `created_by`/`updated_by` に使う。system_admin は users 行を持たないため null
 * (FK 違反回避)、`audit_log.actor_user_id` には降格後 policy (0005) を満たす acting uid、
 * `actor_identity_uid` に IdP uid を残す (詳細は `toHubActor`)。
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

/** 「その他」名が自校で重複するとき tx をロールバックさせる (学校直下=dept NULL は DB 部分 unique 外ゆえ app で封鎖)。 */
class DuplicateError extends Error {}

/**
 * drizzle が wrap した PostgreSQL エラーの SQLSTATE を取り出す。drizzle は元の pg エラーを
 * DrizzleQueryError ("Failed query: …") でラップし、SQLSTATE は top-level ではなく `.cause.code`
 * 側に入るため、cause チェーンを辿る。top-level だけ見ると取りこぼし、同名重複が `conflict` ではなく
 * **未捕捉例外 → ルートエラー境界の 500** になる (本番 digest 2578603502 = 学科「電子工学科」重複登録)。
 * tv の `pgCode` / system-admin の `pgErrorCode` と同方針 (将来は共通ヘルパへ集約したい)。
 */
function pgErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") {
      return code;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** PostgreSQL の unique 制約違反 (SQLSTATE 23505)。同名 (ux_*_school_name) の重複登録など。 */
function isUniqueViolation(error: unknown): boolean {
  return pgErrorCode(error) === "23505";
}

/**
 * mutation の共通後処理: 自校 tx で `build` を実行 → `/app/school` を revalidate →
 * 統一エラー写像。CrossTenantError → invalid、HubNotFoundError → not_found、
 * ChildExistsError → conflict、unique 違反 → conflict (同名 500 化を防ぐ)、
 * それ以外は再 throw (想定外は握り潰さない)。
 */
async function finish<T>(
  build: (tx: TenantTx) => Promise<T>,
  conflictMessage: string,
  schoolId: string,
): Promise<ActionResult<T>> {
  try {
    // tenantScoped: system_admin を school_admin に降格し full_access policy の全校発火を止める
    // (ADR-019 §#95 / Issue #197)。ハブは常に特定 school を対象にするテナントスコープ操作。
    // schoolId: school_admin は自校 (= 渡しても同値)、system_admin は対象校 (/ops 経路)。withSession 側で
    // 「system_admin のときだけ override を honor」するため tenant ロールは自校に固定される (越境防止)。
    const data = await withSession(build, { tenantScoped: true, schoolId });
    revalidatePath("/app/school");
    revalidatePath(`/ops/schools/${schoolId}/hierarchy`);
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
    if (error instanceof DuplicateError) {
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
  schoolId: string,
): Promise<ActionResult<{ id: string }>> {
  return finish(async (tx) => ({ id: await build(tx) }), conflictMessage, schoolId);
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
    actorUserId: actor.actorUserId,
    actorIdentityUid: actor.identityUid,
    schoolId: actor.schoolId,
    tableName: params.tableName,
    recordId: params.recordId,
    operation: params.operation,
    diff: params.diff as object,
    rowHash: "",
    createdBy: actor.userRef,
    updatedBy: actor.userRef,
  });
}

/**
 * 認可 + actor 解決。`targetSchoolId` は **system_admin が特定校を対象にする経路**
 * (/ops/schools/[id]/hierarchy) からのみ意味を持つ。tenant ロール (school_admin) では
 * `toHubActor` が無視し自校に固定する (越境防止)。system_admin で対象校未指定 / 不正なら forbidden。
 */
async function authorize(targetSchoolId?: string): Promise<HubActor | ActionResult<never>> {
  const user = await requireRole(SCHOOL_HIERARCHY_ROLES);
  const actor = toHubActor(user, targetSchoolId);
  if (!actor) {
    return forbidden(
      user.role === "system_admin"
        ? "対象の学校が指定されていません。"
        : "学校に属さないユーザーは階層を編集できません。",
    );
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

/**
 * 自校の「その他」(grade_id NULL) に同一 (department_id, name) が既に存在するか。学校直下 (department_id
 * NULL) は DB 部分 unique が NULL を distinct 扱いし強制しないため、ここで app 層が重複を封鎖する
 * (department 指定時は DB unique と二重化＝race backstop)。RLS で自校に限定 (tenantScoped tx 内)。
 */
async function otherLocationNameExists(
  tx: TenantTx,
  departmentId: string | null,
  name: string,
  excludeId?: string,
): Promise<boolean> {
  const conds = [
    isNull(classes.gradeId),
    eq(classes.name, name),
    departmentId === null ? isNull(classes.departmentId) : eq(classes.departmentId, departmentId),
  ];
  if (excludeId) {
    conds.push(ne(classes.id, excludeId));
  }
  const rows = await tx
    .select({ id: classes.id })
    .from(classes)
    .where(and(...conds))
    .limit(1);
  return rows.length > 0;
}

/** 学科を作成する。 */
export async function createDepartmentAction(
  raw: {
    name?: unknown;
    displayOrder?: unknown;
  },
  targetSchoolId?: string,
): Promise<ActionResult<{ id: string }>> {
  const v = validateDepartmentInput(raw);
  if (!v.ok) {
    return invalid(v.message);
  }
  const actor = await authorize(targetSchoolId);
  if ("ok" in actor) {
    return actor;
  }

  return finishCreate(
    async (tx) => {
      const [row] = await tx
        .insert(departments)
        .values({
          schoolId: actor.schoolId,
          name: v.value.name,
          displayOrder: v.value.displayOrder,
          createdBy: actor.userRef,
          updatedBy: actor.userRef,
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
    },
    "同名の学科が既に存在します。",
    actor.schoolId,
  );
}

/** 学年を作成する。departmentId 指定時は自校の学科か確認してから結線。 */
export async function createGradeAction(
  raw: {
    name?: unknown;
    displayOrder?: unknown;
    hasClasses?: unknown;
    departmentId?: unknown;
  },
  targetSchoolId?: string,
): Promise<ActionResult<{ id: string }>> {
  const v = validateGradeInput(raw);
  if (!v.ok) {
    return invalid(v.message);
  }
  const actor = await authorize(targetSchoolId);
  if ("ok" in actor) {
    return actor;
  }

  return finishCreate(
    async (tx) => {
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
          createdBy: actor.userRef,
          updatedBy: actor.userRef,
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
    },
    "同名の学年が既に存在します。",
    actor.schoolId,
  );
}

/** クラスを作成する。gradeId が自校の学年か確認してから結線。 */
export async function createClassAction(
  raw: {
    gradeId?: unknown;
    name?: unknown;
    grade?: unknown;
  },
  targetSchoolId?: string,
): Promise<ActionResult<{ id: string }>> {
  const v = validateClassInput(raw);
  if (!v.ok) {
    return invalid(v.message);
  }
  const actor = await authorize(targetSchoolId);
  if ("ok" in actor) {
    return actor;
  }

  return finishCreate(
    async (tx) => {
      if (!(await existsInSchool(tx, grades, v.value.gradeId))) {
        throw new CrossTenantError("指定された学年が見つかりません。");
      }
      const [row] = await tx
        .insert(classes)
        .values({
          schoolId: actor.schoolId,
          gradeId: v.value.gradeId,
          name: v.value.name,
          grade: v.value.grade,
          createdBy: actor.userRef,
          updatedBy: actor.userRef,
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
    },
    "同名のクラスが既に存在します。",
    actor.schoolId,
  );
}

/**
 * 「その他」(非教室の設置場所 = 学年なしクラス) を作成する。
 *
 * 通常クラス (createClassAction) と違い gradeId を取らず `grade_id=NULL` / `grade=NULL` で保存する。
 * departmentId 指定時は自校の学科か `existsInSchool` で確認 (cross-tenant 付替防止・既存パターン踏襲)。
 * 名称重複は学科配下なら DB 部分 unique、学校直下 (dept NULL) は `otherLocationNameExists` で封鎖する。
 */
export async function createOtherLocationAction(
  raw: {
    name?: unknown;
    departmentId?: unknown;
  },
  targetSchoolId?: string,
): Promise<ActionResult<{ id: string }>> {
  const v = validateOtherLocationInput(raw);
  if (!v.ok) {
    return invalid(v.message);
  }
  const actor = await authorize(targetSchoolId);
  if ("ok" in actor) {
    return actor;
  }

  return finishCreate(
    async (tx) => {
      if (v.value.departmentId && !(await existsInSchool(tx, departments, v.value.departmentId))) {
        throw new CrossTenantError("指定された学科が見つかりません。");
      }
      if (await otherLocationNameExists(tx, v.value.departmentId, v.value.name)) {
        throw new DuplicateError("同名の設置場所が既に存在します。");
      }
      const [row] = await tx
        .insert(classes)
        .values({
          schoolId: actor.schoolId,
          gradeId: null,
          departmentId: v.value.departmentId,
          name: v.value.name,
          grade: null,
          createdBy: actor.userRef,
          updatedBy: actor.userRef,
        })
        .returning({ id: classes.id });
      const newId = row?.id as string;
      await writeAudit(tx, actor, {
        tableName: "classes",
        recordId: newId,
        operation: "insert",
        diff: {
          after: { name: v.value.name, departmentId: v.value.departmentId, kind: "other_location" },
        },
      });
      return newId;
    },
    "同名の設置場所が既に存在します。",
    actor.schoolId,
  );
}

/* ================================================================== *
 *  update (#48-K2)
 *
 *  全フィールド置換 + 監査 diff (before/after)。対象行は自校 RLS tx で再取得し、
 *  他校 / 不存在は HubNotFoundError → not_found。同名衝突は unique → conflict。
 * ================================================================== */

/** 学科をリネーム / 表示順変更する。 */
export async function updateDepartmentAction(
  raw: {
    id?: unknown;
    name?: unknown;
    displayOrder?: unknown;
  },
  targetSchoolId?: string,
): Promise<ActionResult<{ id: string }>> {
  const v = validateDepartmentUpdate(raw);
  if (!v.ok) {
    return invalid(v.message);
  }
  const actor = await authorize(targetSchoolId);
  if ("ok" in actor) {
    return actor;
  }

  return finish(
    async (tx) => {
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
          updatedBy: actor.userRef,
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
    },
    "同名の学科が既に存在します。",
    actor.schoolId,
  );
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
export async function updateGradeAction(
  raw: {
    id?: unknown;
    name?: unknown;
    displayOrder?: unknown;
    hasClasses?: unknown;
    departmentId?: unknown;
  },
  targetSchoolId?: string,
): Promise<ActionResult<{ id: string }>> {
  const v = validateGradeUpdate(raw);
  if (!v.ok) {
    return invalid(v.message);
  }
  const actor = await authorize(targetSchoolId);
  if ("ok" in actor) {
    return actor;
  }

  return finish(
    async (tx) => {
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
          updatedBy: actor.userRef,
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
    },
    "同名の学年が既に存在します。",
    actor.schoolId,
  );
}

/** クラスをリネーム / 学年数を変更する (親学年の付替は scope 外、別 issue)。 */
export async function updateClassAction(
  raw: {
    id?: unknown;
    name?: unknown;
    grade?: unknown;
  },
  targetSchoolId?: string,
): Promise<ActionResult<{ id: string }>> {
  const v = validateClassUpdate(raw);
  if (!v.ok) {
    return invalid(v.message);
  }
  const actor = await authorize(targetSchoolId);
  if ("ok" in actor) {
    return actor;
  }

  return finish(
    async (tx) => {
      const [before] = await tx
        .select({
          name: classes.name,
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
          grade: v.value.grade,
          updatedBy: actor.userRef,
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
            grade: v.value.grade,
          },
        },
      });
      return { id: v.value.id };
    },
    "同名のクラスが既に存在します。",
    actor.schoolId,
  );
}

/**
 * 「その他」(学年なしクラス) をリネーム / 所属学科の付替する。
 *
 * 対象は自校で可視かつ **`grade_id IS NULL`** (= その他) の行に限る。学年ありの通常クラスを指定した
 * 場合は not_found (改名は updateClassAction の領分)。付替先 department は自校可視性を確認し、名称重複は
 * 学科配下=DB unique・学校直下=`otherLocationNameExists` (自分自身は除外) で封鎖する。削除は末端ゆえ
 * 既存の deleteClassAction を流用する (専用 delete は設けない)。
 */
export async function updateOtherLocationAction(
  raw: {
    id?: unknown;
    name?: unknown;
    departmentId?: unknown;
  },
  targetSchoolId?: string,
): Promise<ActionResult<{ id: string }>> {
  const v = validateOtherLocationUpdate(raw);
  if (!v.ok) {
    return invalid(v.message);
  }
  const actor = await authorize(targetSchoolId);
  if ("ok" in actor) {
    return actor;
  }

  return finish(
    async (tx) => {
      const [before] = await tx
        .select({
          name: classes.name,
          departmentId: classes.departmentId,
          gradeId: classes.gradeId,
        })
        .from(classes)
        .where(eq(classes.id, v.value.id))
        .limit(1);
      if (!before || before.gradeId !== null) {
        // 不可視/不存在、または学年ありの通常クラス (その他ではない) → not_found。
        throw new HubNotFoundError("指定された設置場所が見つかりません。");
      }
      if (v.value.departmentId && !(await existsInSchool(tx, departments, v.value.departmentId))) {
        throw new CrossTenantError("指定された学科が見つかりません。");
      }
      if (await otherLocationNameExists(tx, v.value.departmentId, v.value.name, v.value.id)) {
        throw new DuplicateError("同名の設置場所が既に存在します。");
      }
      await tx
        .update(classes)
        .set({
          name: v.value.name,
          departmentId: v.value.departmentId,
          updatedBy: actor.userRef,
          updatedAt: new Date(),
        })
        .where(eq(classes.id, v.value.id));
      await writeAudit(tx, actor, {
        tableName: "classes",
        recordId: v.value.id,
        operation: "update",
        diff: {
          before: { name: before.name, departmentId: before.departmentId },
          after: { name: v.value.name, departmentId: v.value.departmentId },
        },
      });
      return { id: v.value.id };
    },
    "同名の設置場所が既に存在します。",
    actor.schoolId,
  );
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
  targetSchoolId?: string,
): Promise<ActionResult<{ id: string }>> {
  const v = validateId(rawId);
  if (!v.ok) {
    return invalid(v.message);
  }
  const actor = await authorize(targetSchoolId);
  if ("ok" in actor) {
    return actor;
  }

  return finish(
    async (tx) => {
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
    },
    "削除に失敗しました。",
    actor.schoolId,
  );
}

/** 学年を削除する。属するクラスが 1 件でもあれば拒否 (先にクラスの付替 / 削除が必要)。 */
export async function deleteGradeAction(
  rawId: unknown,
  targetSchoolId?: string,
): Promise<ActionResult<{ id: string }>> {
  const v = validateId(rawId);
  if (!v.ok) {
    return invalid(v.message);
  }
  const actor = await authorize(targetSchoolId);
  if ("ok" in actor) {
    return actor;
  }

  return finish(
    async (tx) => {
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
    },
    "削除に失敗しました。",
    actor.schoolId,
  );
}

/** クラスを削除する。クラスは階層の末端のため子参照ガードは不要。 */
export async function deleteClassAction(
  rawId: unknown,
  targetSchoolId?: string,
): Promise<ActionResult<{ id: string }>> {
  const v = validateId(rawId);
  if (!v.ok) {
    return invalid(v.message);
  }
  const actor = await authorize(targetSchoolId);
  if ("ok" in actor) {
    return actor;
  }

  return finish(
    async (tx) => {
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
    },
    "削除に失敗しました。",
    actor.schoolId,
  );
}

/* ================================================================== *
 *  表示順の一括並べ替え (#48-K3 UX hardening)
 *
 *  学科 / 学年の兄弟集合を新しい並び順 (orderedIds) で受け取り displayOrder=0..n-1 を **単一 RLS tx で
 *  原子的に**反映する。従来はクライアントが兄弟ごとに updateXAction を N 回呼んでいた (N 往復・非原子・
 *  revalidate も N 回)。これを 1 往復 / 1 tx に畳み、途中失敗時の半端な並びを防ぐ。各 id は自校で可視か
 *  確認し (RLS は他校 UPDATE を 0 行化するが、明示確認で他校/不存在混入を not_found で全体巻き戻し)、
 *  displayOrder が既に正しい行は更新・監査しない (無駄 write 抑制)。クラスは並べ替え列が無いため対象外。
 * ================================================================== */

/** 学科 / 学年の表示順を一括で並べ替える。orderedIds の順に displayOrder=0..n-1 を原子的に反映する。 */
export async function reorderHierarchyAction(
  raw: {
    entity?: unknown;
    orderedIds?: unknown;
  },
  targetSchoolId?: string,
): Promise<ActionResult<{ count: number }>> {
  const v = validateReorder(raw);
  if (!v.ok) {
    return invalid(v.message);
  }
  const actor = await authorize(targetSchoolId);
  if ("ok" in actor) {
    return actor;
  }
  const table = v.value.entity === "department" ? departments : grades;
  const tableName = v.value.entity === "department" ? "departments" : "grades";
  const entityLabel = v.value.entity === "department" ? "学科" : "学年";

  return finish(
    async (tx) => {
      let count = 0;
      for (const [i, id] of v.value.orderedIds.entries()) {
        // 自校で可視か + 現在の displayOrder を取得 (RLS で他校行は不可視 → not_found で全体巻き戻し)。
        const [row] = await tx
          .select({ displayOrder: table.displayOrder })
          .from(table)
          .where(eq(table.id, id))
          .limit(1);
        if (!row) {
          throw new HubNotFoundError(`指定された${entityLabel}が見つかりません。`);
        }
        if (row.displayOrder === i) {
          continue; // 既に正しい順 → 無駄な update/監査を避ける。
        }
        // update は drizzle のテーブル型のため具体テーブルで分岐する (select は union で可)。
        if (v.value.entity === "department") {
          await tx
            .update(departments)
            .set({ displayOrder: i, updatedBy: actor.userRef, updatedAt: new Date() })
            .where(eq(departments.id, id));
        } else {
          await tx
            .update(grades)
            .set({ displayOrder: i, updatedBy: actor.userRef, updatedAt: new Date() })
            .where(eq(grades.id, id));
        }
        await writeAudit(tx, actor, {
          tableName,
          recordId: id,
          operation: "update",
          diff: {
            before: { displayOrder: row.displayOrder },
            after: { displayOrder: i },
            reason: "reorder",
          },
        });
        count += 1;
      }
      return { count };
    },
    "並べ替えに失敗しました。",
    actor.schoolId,
  );
}
