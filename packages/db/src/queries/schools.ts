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
