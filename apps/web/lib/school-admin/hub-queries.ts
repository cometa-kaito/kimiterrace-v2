import { type TenantTx, classes, dailyData, departments, grades } from "@kimiterrace/db";
import { asc, count, desc, eq, sql } from "drizzle-orm";
import { type ClassYearRow, classDupKey } from "./hub-core";

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

/* ------------------------------------------------------------------ *
 *  本日(JST)の掲示状態 (#48-K3 PR2)
 *
 *  サイネージは getEffectiveDailyData が class > grade > department > school の順に daily_data を
 *  継承マージして表示する (signage-display.ts)。学校管理ハブでは各クラスが「本日 掲示する中身を
 *  持つか」を一覧で示したい。そこで本日(JST)付けで **予定/連絡/提出物のいずれかが 1 件以上ある**
 *  daily_data を scope 別に集め、純関数 computeTodayActiveClasses で各クラスへ継承伝搬する。
 *  日付境界は TZ 事故を避けるため SQL 側で `(now() AT TIME ZONE 'Asia/Tokyo')::date` と比較する。
 *  RLS により自校の daily_data のみが対象 (ルール2)。
 *
 *  ⚠ ここで見るのは **本日(JST)付けの行のみ**。サイネージ実表示 (getEffectiveDailyData) は
 *  notices/assignments を多日 lookback (effective-daily-data.ts EFFECTIVE_LOOKBACK_DAYS) するため、
 *  昨日以前に入れた複数日連絡や期限内の提出物が今日も画面に出ているクラスでも本指標は「本日 未入力」と
 *  なり得る。つまりこれは **本日の新規入力有無** の指標であり、サイネージ実表示の網羅ではない。
 * ------------------------------------------------------------------ */

/** 本日(JST)に中身のある daily_data の scope と対象 id。 */
export type TodayDailyDataScopes = {
  school: boolean;
  departmentIds: string[];
  gradeIds: string[];
  classIds: string[];
};

export async function getTodayDailyDataScopes(tx: TenantTx): Promise<TodayDailyDataScopes> {
  const rows = await tx
    .select({
      scope: dailyData.scope,
      gradeId: dailyData.gradeId,
      departmentId: dailyData.departmentId,
      classId: dailyData.classId,
    })
    .from(dailyData)
    .where(
      sql`${dailyData.date} = (now() AT TIME ZONE 'Asia/Tokyo')::date AND (
        jsonb_array_length(${dailyData.schedules}) > 0
        OR jsonb_array_length(${dailyData.notices}) > 0
        OR jsonb_array_length(${dailyData.assignments}) > 0
      )`,
    );
  const out: TodayDailyDataScopes = {
    school: false,
    departmentIds: [],
    gradeIds: [],
    classIds: [],
  };
  for (const r of rows) {
    if (r.scope === "school") {
      out.school = true;
    } else if (r.scope === "department" && r.departmentId) {
      out.departmentIds.push(r.departmentId);
    } else if (r.scope === "grade" && r.gradeId) {
      out.gradeIds.push(r.gradeId);
    } else if (r.scope === "class" && r.classId) {
      out.classIds.push(r.classId);
    }
  }
  return out;
}

/**
 * scope 集合と学年ツリーから「本日 掲示中身あり」のクラス id 集合を作る純関数 (継承伝搬)。
 * クラスが active = 自クラス scope / 親学年 scope / 親学科 scope / 学校 scope のいずれかに本日中身あり。
 * UI へは Record<classId, boolean> で渡す (serializable・client へ素通し可)。
 */
export function computeTodayActiveClasses(
  scopes: TodayDailyDataScopes,
  grades: GradeView[],
): Record<string, boolean> {
  const deptSet = new Set(scopes.departmentIds);
  const gradeSet = new Set(scopes.gradeIds);
  const classSet = new Set(scopes.classIds);
  const out: Record<string, boolean> = {};
  for (const g of grades) {
    const gradeActive =
      scopes.school || gradeSet.has(g.id) || (g.departmentId ? deptSet.has(g.departmentId) : false);
    for (const c of g.classes) {
      out[c.id] = gradeActive || classSet.has(c.id);
    }
  }
  return out;
}

/** 自校の全クラスの年度・親学年・名前・学年数 (新年度複製 #48-K3 PR3 の元データ・RLS 自校限定)。 */
export async function getClassYearRows(tx: TenantTx): Promise<ClassYearRow[]> {
  return tx
    .select({
      gradeId: classes.gradeId,
      name: classes.name,
      grade: classes.grade,
      academicYear: classes.academicYear,
    })
    .from(classes);
}

/**
 * 指定年度に既に存在するクラスの classDupKey 集合（gradeId=null は除外・自校 RLS 限定）。
 *
 * 「新年度へ複製」(#48-K3 PR3 冪等化) で target 年度の既存クラスを insert 前に取得し除外するために使う。
 * getClassYearRows とは別の SELECT として **insert 直前に**呼ぶことで、並行 tx が target 年度クラスを
 * 先にコミットしていれば READ COMMITTED でそれを観測でき、重複 insert (→ 23505) を graceful に避けられる。
 * 観測できない phantom race の恒久ガードは部分 unique index ux_classes_school_year_grade_name。
 * RLS により自校のみが対象 (ルール2、手書き WHERE school_id は書かない)。
 */
export async function getTargetYearClassKeys(
  tx: TenantTx,
  targetYear: number,
): Promise<Set<string>> {
  const rows = await tx
    .select({ gradeId: classes.gradeId, name: classes.name })
    .from(classes)
    .where(eq(classes.academicYear, targetYear));
  const keys = new Set<string>();
  for (const r of rows) {
    if (r.gradeId) {
      keys.add(classDupKey(r.gradeId, r.name));
    }
  }
  return keys;
}
