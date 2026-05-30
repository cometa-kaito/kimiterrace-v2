import { type TenantTx, classes, departments, grades } from "@kimiterrace/db";
import { asc, desc } from "drizzle-orm";

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
