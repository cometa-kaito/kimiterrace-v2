import { type TenantTx, classes, departments, grades } from "@kimiterrace/db";
import { asc, count, desc, eq } from "drizzle-orm";

/**
 * 学校管理者ハブの読み取り (#48-K)。自校の学科・学年・クラス階層を取得する。
 *
 * **RLS (ルール2)**: `withSession` の自校コンテキスト tx 内で呼ぶ。各テーブルの
 * `tenant_isolation` policy により `app.current_school_id` で自校に限定される
 * (手書き WHERE school_id は書かない、DB レベルで強制)。
 */

export type DepartmentView = { id: string; name: string; displayOrder: number };
export type ClassView = {
  id: string;
  name: string;
  academicYear: number;
  grade: number;
};
export type GradeView = {
  id: string;
  name: string;
  displayOrder: number;
  hasClasses: boolean;
  departmentId: string | null;
  classes: ClassView[];
};
export type SchoolHierarchy = { departments: DepartmentView[]; grades: GradeView[] };

export async function getSchoolHierarchy(tx: TenantTx): Promise<SchoolHierarchy> {
  const [deptRows, gradeRows, classRows] = await Promise.all([
    tx
      .select({
        id: departments.id,
        name: departments.name,
        displayOrder: departments.displayOrder,
      })
      .from(departments)
      .orderBy(asc(departments.displayOrder), asc(departments.name)),
    tx
      .select({
        id: grades.id,
        name: grades.name,
        displayOrder: grades.displayOrder,
        hasClasses: grades.hasClasses,
        departmentId: grades.departmentId,
      })
      .from(grades)
      .orderBy(asc(grades.displayOrder), asc(grades.name)),
    tx
      .select({
        id: classes.id,
        gradeId: classes.gradeId,
        name: classes.name,
        academicYear: classes.academicYear,
        grade: classes.grade,
      })
      .from(classes)
      .orderBy(desc(classes.academicYear), asc(classes.grade), asc(classes.name)),
  ]);

  // クラスを親学年ごとにまとめる (学年未割当 = grade_id null は階層外として除外)。
  const byGrade = new Map<string, ClassView[]>();
  for (const c of classRows) {
    if (!c.gradeId) {
      continue;
    }
    const list = byGrade.get(c.gradeId) ?? [];
    list.push({ id: c.id, name: c.name, academicYear: c.academicYear, grade: c.grade });
    byGrade.set(c.gradeId, list);
  }

  return {
    departments: deptRows,
    grades: gradeRows.map((g) => ({ ...g, classes: byGrade.get(g.id) ?? [] })),
  };
}

/* ------------------------------------------------------------------ *
 *  子参照ガード用カウント (#48-K2 delete)
 *
 *  FK は `onDelete: "set null"` のため DB は削除を拒否せず子を孤児化する
 *  (grades.department_id / classes.grade_id)。削除で階層が静かに壊れるのを防ぐため、
 *  アプリ層で「子が残っているか」を**自校 RLS tx 内**で数えて拒否する。
 *  RLS により他校の子はカウントされない (テナント分離はここでも DB が強制)。
 * ------------------------------------------------------------------ */

/** 指定学科に属する学年数 (自校のみ)。> 0 なら学科削除を拒否する。 */
export async function countGradesInDepartment(tx: TenantTx, departmentId: string): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(grades)
    .where(eq(grades.departmentId, departmentId));
  return row?.n ?? 0;
}

/** 指定学年に属するクラス数 (自校のみ)。> 0 なら学年削除を拒否する。 */
export async function countClassesInGrade(tx: TenantTx, gradeId: string): Promise<number> {
  const [row] = await tx.select({ n: count() }).from(classes).where(eq(classes.gradeId, gradeId));
  return row?.n ?? 0;
}
