import type {
  ads,
  classes,
  dailyData,
  departments,
  grades,
  schoolConfigs,
  schools,
} from "@kimiterrace/db";
import type { InferInsertModel } from "drizzle-orm";
import { v2Id } from "./ids.js";
import type { V1Ad, V1Config, V1DailyDoc, V1Export, V1School } from "./types.js";

/**
 * V1 エクスポート → V2 挿入行への**純粋変換** (#48-D)。副作用なし・DB 非依存でフルにテストできる。
 *
 * - id は決定論的 UUID (ids.ts) で導出 → 冪等 (再実行で同じ行)。
 * - 行型は Drizzle スキーマから `InferInsertModel` で派生 (CLAUDE.md ルール3、手書き型の二重管理なし)。
 * - 監査カラム `created_by` / `updated_by` は **null** (システム移行、ルール1 の nullable 規定どおり)。
 * - scope + *_id の整合は schema の CHECK 制約に合うよう `scopeColumns` で一元的に組む。
 */

type SchoolRow = InferInsertModel<typeof schools>;
type DepartmentRow = InferInsertModel<typeof departments>;
type GradeRow = InferInsertModel<typeof grades>;
type ClassRow = InferInsertModel<typeof classes>;
type ConfigRow = InferInsertModel<typeof schoolConfigs>;
type DailyRow = InferInsertModel<typeof dailyData>;
type AdRow = InferInsertModel<typeof ads>;

/** FK 依存順 (親→子) に並べた、テーブルごとの挿入行束。importer はこの順で upsert する。 */
export type MigrationRows = {
  schools: SchoolRow[];
  departments: DepartmentRow[];
  grades: GradeRow[];
  classes: ClassRow[];
  schoolConfigs: ConfigRow[];
  dailyData: DailyRow[];
  ads: AdRow[];
};

type HierarchyScope = "school" | "grade" | "department" | "class";

/**
 * scope に応じた *_id 列を組む (他はすべて null)。schema の ck_*_scope を満たす形。
 *
 * 注: grade / class スコープの行に department_id を**冗長保持しない**。学科への伝搬は
 * `grades.department_id` / `classes.grade_id` の FK リンクを #48-F の `effective_ads_per_class`
 * VIEW が辿って解決する (非正規化せず単一ソースは階層リンク FK 側に置く)。
 */
function scopeColumns(
  scope: HierarchyScope,
  ids: { gradeId?: string; departmentId?: string; classId?: string },
): {
  scope: HierarchyScope;
  gradeId: string | null;
  departmentId: string | null;
  classId: string | null;
} {
  return {
    scope,
    gradeId: scope === "grade" ? (ids.gradeId ?? null) : null,
    departmentId: scope === "department" ? (ids.departmentId ?? null) : null,
    classId: scope === "class" ? (ids.classId ?? null) : null,
  };
}

function adRows(
  schoolId: string,
  scope: HierarchyScope,
  scopeKey: string,
  ids: { gradeId?: string; departmentId?: string; classId?: string },
  list: V1Ad[] | undefined,
): AdRow[] {
  return (list ?? []).map((ad, i) => ({
    id: v2Id.ad(schoolId, `${scope}:${scopeKey}`, i),
    schoolId,
    ...scopeColumns(scope, ids),
    mediaUrl: ad.mediaUrl,
    mediaType: ad.mediaType,
    durationSec: ad.durationSec ?? 5,
    linkUrl: ad.linkUrl ?? null,
    caption: ad.caption ?? null,
    captionFontScale: ad.captionFontScale ?? 1,
    displayOrder: ad.displayOrder ?? i,
    createdBy: null,
    updatedBy: null,
  }));
}

function configRows(
  schoolId: string,
  scope: HierarchyScope,
  scopeKey: string,
  ids: { gradeId?: string; departmentId?: string; classId?: string },
  list: V1Config[] | undefined,
): ConfigRow[] {
  return (list ?? []).map((cfg) => ({
    id: v2Id.config(schoolId, `${scope}:${scopeKey}`, cfg.kind),
    schoolId,
    ...scopeColumns(scope, ids),
    kind: cfg.kind,
    value: (cfg.value ?? {}) as object,
    createdBy: null,
    updatedBy: null,
  }));
}

function dailyRows(
  schoolId: string,
  scope: HierarchyScope,
  scopeKey: string,
  ids: { gradeId?: string; departmentId?: string; classId?: string },
  list: V1DailyDoc[] | undefined,
): DailyRow[] {
  return (list ?? []).map((d) => ({
    id: v2Id.dailyData(schoolId, `${scope}:${scopeKey}`, d.date),
    schoolId,
    ...scopeColumns(scope, ids),
    date: d.date,
    schedules: d.schedules ?? [],
    notices: d.notices ?? [],
    assignments: d.assignments ?? [],
    quietHours: d.quietHours ?? [],
    createdBy: null,
    updatedBy: null,
  }));
}

function transformSchool(s: V1School, out: MigrationRows): void {
  const schoolId = v2Id.school(s.id);
  out.schools.push({
    id: schoolId,
    name: s.name,
    prefecture: s.prefecture ?? "不明",
    code: s.code ?? null,
    notes: null,
    createdBy: null,
    updatedBy: null,
  });

  // 学校スコープの設定・広告・日次。
  out.schoolConfigs.push(...configRows(schoolId, "school", "school", {}, s.configs));
  out.ads.push(...adRows(schoolId, "school", "school", {}, s.ads));
  out.dailyData.push(...dailyRows(schoolId, "school", "school", {}, s.masterDailyData));

  for (const dept of s.departments ?? []) {
    const departmentId = v2Id.department(s.id, dept.id);
    out.departments.push({
      id: departmentId,
      schoolId,
      name: dept.name,
      displayOrder: dept.displayOrder ?? 0,
      createdBy: null,
      updatedBy: null,
    });
    const key = `dept:${dept.id}`;
    out.schoolConfigs.push(
      ...configRows(schoolId, "department", key, { departmentId }, dept.configs),
    );
    out.ads.push(...adRows(schoolId, "department", key, { departmentId }, dept.ads));
  }

  for (const grade of s.grades ?? []) {
    const gradeId = v2Id.grade(s.id, grade.id);
    out.grades.push({
      id: gradeId,
      schoolId,
      departmentId: grade.departmentId ? v2Id.department(s.id, grade.departmentId) : null,
      name: grade.name,
      displayOrder: grade.displayOrder ?? 0,
      hasClasses: grade.hasClasses ?? true,
      createdBy: null,
      updatedBy: null,
    });
    const gkey = `grade:${grade.id}`;
    out.schoolConfigs.push(...configRows(schoolId, "grade", gkey, { gradeId }, grade.configs));
    out.ads.push(...adRows(schoolId, "grade", gkey, { gradeId }, grade.ads));
    out.dailyData.push(...dailyRows(schoolId, "grade", gkey, { gradeId }, grade.dailyData));

    for (const cls of grade.classes ?? []) {
      const classId = v2Id.class(s.id, grade.id, cls.id);
      // V1 の academicYear は v2 では破棄（年度撤去でクラスは校内の単一集合）。
      out.classes.push({
        id: classId,
        schoolId,
        gradeId,
        name: cls.name,
        grade: cls.grade,
        createdBy: null,
        updatedBy: null,
      });
      const ckey = `class:${cls.id}`;
      out.schoolConfigs.push(...configRows(schoolId, "class", ckey, { classId }, cls.configs));
      out.ads.push(...adRows(schoolId, "class", ckey, { classId }, cls.ads));
      out.dailyData.push(...dailyRows(schoolId, "class", ckey, { classId }, cls.dailyData));
    }
  }
}

/**
 * V1 エクスポート全体を V2 挿入行束に変換する。importer はこの束を FK 依存順に upsert する。
 */
export function transformExport(exportData: V1Export): MigrationRows {
  const out: MigrationRows = {
    schools: [],
    departments: [],
    grades: [],
    classes: [],
    schoolConfigs: [],
    dailyData: [],
    ads: [],
  };
  for (const s of exportData.schools) {
    transformSchool(s, out);
  }
  return out;
}
