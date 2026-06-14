import {
  type DailyWindowRow,
  type TenantTx,
  classes,
  departments,
  getDailyWindowRows,
  grades,
} from "@kimiterrace/db";
import { asc, count, desc, eq } from "drizzle-orm";
import {
  EFFECTIVE_LOOKBACK_DAYS,
  isAssignmentActive,
  isNoticeActive,
} from "@/lib/signage/effective-daily-data";
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
 *  本日(JST)の掲示状態 (#48-K3 PR2、サイネージ実表示に整合)
 *
 *  サイネージは getEffectiveDailyData が class > grade > department > school の順に daily_data を
 *  継承マージして表示する (signage-display.ts)。学校管理ハブでは各クラスが「本日サイネージに掲示する
 *  中身を持つか」を一覧で示したい。
 *
 *  判定は **サイネージ実表示と同じ遡及窓** で行う: getDailyWindowRows が今日を含む過去
 *  EFFECTIVE_LOOKBACK_DAYS 日ぶんの自校 daily_data を全 scope まとめて取得し (N クラスを 1 クエリ)、
 *  reduceTodayActiveScopes が `isNoticeActive` / `isAssignmentActive` (サイネージと同 helper = 活性
 *  ロジックの単一ソース) で「今日も掲示中の中身を持つ scope」を集める。schedules は当日行のみ、
 *  notices/assignments は表示日数・期限+猶予で多日判定する (effective-daily-data の
 *  mergeEffectiveWithWindow と同規約)。集めた scope は純関数 computeTodayActiveClasses で各クラスへ
 *  継承伝搬する (per-field 最具体勝ちは「何か出るか」の真偽では scope 横断 OR と等価)。
 *
 *  これにより「昨日入れた複数日連絡」「期限内の提出物 (今日の行なし)」のクラスも、サイネージに出ている
 *  限り「公開中」と表示される (旧実装の "本日付けの行のみ" による過小表示を解消)。日付境界は TZ 事故を
 *  避けるため getDailyWindowRows が SQL 側 JST で決める。RLS により自校の daily_data のみが対象 (ルール2)。
 * ------------------------------------------------------------------ */

/** 本日サイネージに掲示中の中身を持つ daily_data の scope と対象 id。 */
export type TodayDailyDataScopes = {
  school: boolean;
  departmentIds: string[];
  gradeIds: string[];
  classIds: string[];
};

export async function getTodayDailyDataScopes(tx: TenantTx): Promise<TodayDailyDataScopes> {
  const rows = await getDailyWindowRows(tx, EFFECTIVE_LOOKBACK_DAYS);
  return reduceTodayActiveScopes(rows);
}

/** 配列なら中身を返す (jsonb は通常配列だが防御的に)。それ以外は空配列。 */
function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * 遡及窓の 1 行が「今日サイネージに掲示される中身」を持つか (純関数)。schedules は当日行のみ、
 * notices/assignments は窓内で表示日数・期限+猶予が今日も活きているかで判定する ─ サイネージ実表示
 * (effective-daily-data の mergeEffectiveWithWindow) と同規約・同 helper を流用し単一ソースを保つ。
 */
export function isWindowRowActiveToday(r: DailyWindowRow): boolean {
  // schedules: 当日行のみ (過去日の予定は今日のサイネージには出ない)。
  if (r.date === r.today && toArray(r.schedules).length > 0) {
    return true;
  }
  // notices: 入力日から表示日数ぶん。窓内に今日も活性な連絡が 1 件でもあれば。
  if (toArray(r.notices).some((n) => isNoticeActive(n, r.date, r.today))) {
    return true;
  }
  // assignments: 期限 + 猶予日まで自動表示。窓内に今日も活性な提出物が 1 件でもあれば。
  if (toArray(r.assignments).some((a) => isAssignmentActive(a, r.today))) {
    return true;
  }
  return false;
}

/**
 * 遡及窓の行集合から「今日サイネージに掲示中の中身を持つ」scope 集合を作る純関数。
 * 各行を isWindowRowActiveToday で判定し、活性な行の scope を集める。
 * (TodayDailyDataScopes → 各クラスへの継承伝搬は computeTodayActiveClasses が担う。)
 */
export function reduceTodayActiveScopes(rows: DailyWindowRow[]): TodayDailyDataScopes {
  const out: TodayDailyDataScopes = {
    school: false,
    departmentIds: [],
    gradeIds: [],
    classIds: [],
  };
  for (const r of rows) {
    if (!isWindowRowActiveToday(r)) {
      continue;
    }
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
