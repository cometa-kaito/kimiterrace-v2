import { type InferSelectModel, asc, count, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { classes } from "../schema/classes.js";
import { departments } from "../schema/departments.js";
import { grades } from "../schema/grades.js";
import { schools } from "../schema/schools.js";

/**
 * #48-L (#123): システム管理者向けの学校 (テナント) マスタ クエリ層。
 *
 * テナント分離は **呼び出し接続の RLS コンテキスト** (`app.current_user_role` / `app.current_school_id`、
 * ADR-019) が DB レベルで強制する。schools には複数の policy があり (0002_rls_policies.sql):
 * - `system_admin_full_access` (role=system_admin) → **全校 SELECT/UPDATE 可**
 * - `tenant_self_read` (id = current_school_id) → 自校 1 件のみ SELECT
 * - `tenant_isolation_modify` (id = current_school_id) → 自校のみ UPDATE
 * したがって本モジュールは `WHERE` で role/school を**書かない** — RLS に委ねる (CLAUDE.md ルール2)。
 * 単一行の取得/更新は `id` で WHERE するが、これはテナント境界ではなく対象特定のための条件で、
 * 越権は RLS が弾く (他校 id を渡しても school_admin には 0 行で見えない / 更新できない)。
 * 呼び出し側は RLS をバイパスしない接続ロール (kimiterrace_app) を使うこと。
 *
 * 型は schema の `schools` から `InferSelectModel` で派生する (ルール3)。
 */

/** SELECT だけできれば良い (Drizzle db / トランザクションの両方を受ける)。 */
type Selectable = Pick<PostgresJsDatabase, "select">;
/** SELECT + UPDATE が要る編集系 (トランザクションを受ける)。 */
type Mutable = Pick<PostgresJsDatabase, "select" | "update">;
/** INSERT が要る作成系 (トランザクションを受ける)。 */
type Insertable = Pick<PostgresJsDatabase, "insert">;
/** DELETE が要る削除系 (トランザクションを受ける)。 */
type Deletable = Pick<PostgresJsDatabase, "delete">;

type SchoolRow = InferSelectModel<typeof schools>;

/** 学校一覧 1 行 (一覧用の軽量射影、notes は含めない)。 */
export type SchoolSummary = Pick<
  SchoolRow,
  "id" | "name" | "prefecture" | "code" | "hierarchyMode" | "createdAt"
>;

/** 学校編集フォーム用の射影 (一覧 + notes、編集対象の基本フィールド)。 */
export type SchoolEditable = Pick<
  SchoolRow,
  "id" | "name" | "prefecture" | "code" | "hierarchyMode" | "notes"
>;

/** 学校詳細 (#48-L2): マスタ全フィールド + 配下の階層 (学年/クラス/学科) 件数。 */
export type SchoolDetail = {
  school: SchoolRow;
  counts: { grades: number; classes: number; departments: number };
};

/** updateSchool が書き込む基本フィールド (型は schema 由来、ルール3)。 */
export type SchoolUpdate = Pick<SchoolRow, "name" | "prefecture" | "code" | "hierarchyMode">;

/** createSchool が書き込む基本フィールド (型は schema 由来、ルール3)。 */
export type SchoolCreate = Pick<SchoolRow, "name" | "prefecture" | "code" | "hierarchyMode">;

/**
 * 学校一覧を取得する。可視範囲は RLS が決める (system_admin=全校 / テナント=自校のみ)。
 * 都道府県 → 校名 → id の順で決定的に並べる (同名校でも順序が安定)。
 */
export async function listSchools(db: Selectable): Promise<SchoolSummary[]> {
  return db
    .select({
      id: schools.id,
      name: schools.name,
      prefecture: schools.prefecture,
      code: schools.code,
      hierarchyMode: schools.hierarchyMode,
      createdAt: schools.createdAt,
    })
    .from(schools)
    .orderBy(asc(schools.prefecture), asc(schools.name), asc(schools.id));
}

/**
 * 学校 1 件を編集用に取得する。RLS で不可視 (他校 / 不存在) なら `undefined`。
 * `id` は対象特定の条件であってテナント境界ではない (越権は RLS が弾く、上記参照)。
 */
export async function getSchool(db: Selectable, id: string): Promise<SchoolEditable | undefined> {
  const [row] = await db
    .select({
      id: schools.id,
      name: schools.name,
      prefecture: schools.prefecture,
      code: schools.code,
      hierarchyMode: schools.hierarchyMode,
      notes: schools.notes,
    })
    .from(schools)
    .where(eq(schools.id, id))
    .limit(1);
  return row;
}

/**
 * 学校 1 件の詳細 (#48-L2) を取得する。マスタ全フィールド + 配下の学年/クラス/学科の件数。
 * RLS で不可視 (他校 / 不存在) なら `null`。
 *
 * `WHERE id` / `WHERE school_id = id` は**対象特定**の条件であってテナント境界ではない:
 * system_admin は `system_admin_full_access` で全校の行を見られるため、特定校の配下件数を数えるには
 * 明示的に school_id で絞り込む (この絞り込みが無いと全校合算になる)。テナント (school_admin/teacher)
 * が他校 id を渡しても RLS が 0 行に倒すため越権は生じない (多層防御、本ページは system_admin 専用)。
 */
export async function getSchoolDetail(db: Selectable, id: string): Promise<SchoolDetail | null> {
  const [school] = await db.select().from(schools).where(eq(schools.id, id)).limit(1);
  if (!school) {
    return null;
  }
  const [gradeRow, classRow, departmentRow] = await Promise.all([
    db.select({ n: count() }).from(grades).where(eq(grades.schoolId, id)),
    db.select({ n: count() }).from(classes).where(eq(classes.schoolId, id)),
    db.select({ n: count() }).from(departments).where(eq(departments.schoolId, id)),
  ]);
  return {
    school,
    counts: {
      grades: gradeRow[0]?.n ?? 0,
      classes: classRow[0]?.n ?? 0,
      departments: departmentRow[0]?.n ?? 0,
    },
  };
}

/**
 * 学校 (テナント) を新規作成し、作成行の id を返す (#48-L3)。
 *
 * RLS: schools への INSERT は `system_admin_full_access` の WITH CHECK (role=system_admin) でのみ通る。
 * テナント (school_admin/teacher) 向けの INSERT policy は無いため、RLS が拒否する (越権防止、ルール2)。
 * `created_by` / `updated_by` は呼び出し側 (Server Action) が actor から渡す (system_admin は users 行で
 * ないため NULL、ルール1 / FK は users(id))。
 */
export async function createSchool(
  db: Insertable,
  input: SchoolCreate & { createdBy: string | null },
): Promise<{ id: string }[]> {
  return db
    .insert(schools)
    .values({
      name: input.name,
      prefecture: input.prefecture,
      code: input.code,
      hierarchyMode: input.hierarchyMode,
      createdBy: input.createdBy,
      updatedBy: input.createdBy,
    })
    .returning({ id: schools.id });
}

/**
 * 学校の基本フィールドを更新し、影響行を返す (0 = RLS で不可視 / 不存在)。
 *
 * `WHERE id` のみ書き、テナント条件は書かない: school_admin は `tenant_isolation_modify` により
 * 自校のみ UPDATE 可 (他校 id は 0 行)、system_admin は `system_admin_full_access` により全校 UPDATE 可。
 * 更新者 (updated_by) と updated_at は呼び出し側 (Server Action) が actor から渡す (ルール1)。
 */
export async function updateSchool(
  db: Mutable,
  id: string,
  patch: SchoolUpdate & { updatedBy: string | null },
): Promise<{ id: string }[]> {
  return db
    .update(schools)
    .set({
      name: patch.name,
      prefecture: patch.prefecture,
      code: patch.code,
      hierarchyMode: patch.hierarchyMode,
      updatedBy: patch.updatedBy,
      updatedAt: new Date(),
    })
    .where(eq(schools.id, id))
    .returning({ id: schools.id });
}

/**
 * 学校 (テナント) を削除し、削除行の id を返す (#48-L4)。0 行 = RLS で不可視 / 不存在。
 *
 * **子データ保護は DB が強制する (ルール2)**: schools を参照する**テナント所有**テーブル (users / grades /
 * classes / departments / contents / events / ai_* / teacher_inputs / magic_links / ads / daily_data /
 * school_configs / memberships / publishes / monthly_reports 等) は `ON DELETE RESTRICT` のため、
 * 子行が 1 つでも残る学校の DELETE は FK 違反 (SQLSTATE 23503) になる。呼び出し側はこれを conflict に
 * 写像し「空の学校のみ削除可」を担保する (soft-delete を導入せず hard-delete を安全側に倒す)。
 *
 * **例外 (cross-tenant 参照)**: 一部のテーブルは school_id が**テナント分離キーではない任意参照**で、
 * 学校の生存期間に結合しない設計のため RESTRICT ではない (= 上記は「全テーブル RESTRICT」ではない):
 * - `feedback.school_id` … `ON DELETE SET NULL` (匿名・自己申告参照、system_admin のみ閲覧、
 *   schema/feedback.ts)。feedback だけを持つ学校は「空校」扱いで削除でき、削除後 feedback 行は
 *   school_id=NULL で生存する (PII を含む `student_episode` も保持され、引き続き system_admin の閲覧対象)。
 *   feedback をテナント生存期間と decouple する**意図的設計** — テナント所有でない feedback が 1 件でも
 *   あれば学校を永久に削除不能 (RESTRICT) にしてしまうのを避ける (#239 Reviewer H-1)。
 * - `audit_log.school_id` … FK ではない (cross-tenant 用) ため、作成時監査行は削除を阻まない。
 *
 * RLS: `system_admin_full_access` (全校 DELETE 可) / `tenant_isolation_delete` (自校のみ)。`WHERE id` は
 * 対象特定であってテナント境界ではない (越権は RLS が弾く、本ページは system_admin 専用)。
 */
export async function deleteSchool(db: Deletable, id: string): Promise<{ id: string }[]> {
  return db.delete(schools).where(eq(schools.id, id)).returning({ id: schools.id });
}
