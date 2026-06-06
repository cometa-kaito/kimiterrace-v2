import { type TenantTx, classes, grades } from "@kimiterrace/db";
import { asc, desc, eq } from "drizzle-orm";

/**
 * F10 / #46: **system_admin（運営）の広告掲載導線**用に、指定校のクラス一覧を取得する。
 *
 * 運営が広告主の素材を各クラスのサイネージへ掲載できるよう、`/admin/system/schools/{id}/ads` から
 * クラスを選んで `/admin/editor/{classId}/ads`（クラス別広告管理、ADS_ROLES = school_admin/system_admin）
 * へ導く。
 *
 * **テナント境界は RLS が担保（ルール2）**: 本関数は **system_admin の RLS コンテキスト
 * (system_admin_full_access policy) 下で呼ぶ前提**。`where(school_id = schoolId)` は越境防止ではなく
 * 「どの校を表示するか」の**対象特定**（system_admin は全校可視のため明示フィルタで 1 校に絞る、#410 と
 * 同方針）。school_admin が誤って呼んでも RLS が自校のみに絞るため越境はしない。
 */
export type SchoolClassForAdPlacement = {
  classId: string;
  className: string;
  gradeName: string;
  academicYear: number;
};

export async function listSchoolClassesForAdPlacement(
  tx: TenantTx,
  schoolId: string,
): Promise<SchoolClassForAdPlacement[]> {
  const rows = await tx
    .select({
      classId: classes.id,
      className: classes.name,
      academicYear: classes.academicYear,
      grade: classes.grade,
      gradeName: grades.name,
    })
    .from(classes)
    .leftJoin(grades, eq(classes.gradeId, grades.id))
    .where(eq(classes.schoolId, schoolId))
    .orderBy(desc(classes.academicYear), asc(classes.grade), asc(classes.name));

  return rows.map((r) => ({
    classId: r.classId,
    className: r.className,
    academicYear: r.academicYear,
    // 学年未割当 (grade_id null → leftJoin で gradeName null) は文言でフォールバック。
    gradeName: r.gradeName ?? "（学年未割当）",
  }));
}
