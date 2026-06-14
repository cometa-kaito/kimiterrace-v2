import { type TenantTx, classes, departments, grades, tvDevices } from "@kimiterrace/db";
import type { InferSelectModel } from "drizzle-orm";
import { and, eq, isNull } from "drizzle-orm";

/**
 * 運営整理 §4 item3: 学校詳細 (`/ops/schools/[id]`) の **階層ツリー** 組み立て層。
 *
 * 学校詳細を「数字サマリ止まり」にせず、**学科 → 学年 → クラス → 設置場所 → モニタ** のツリーで展開するための
 * データ取得 + 純粋な組み立て。物理最小単位は **モニタ = `tv_devices` 1 行**で、その `label` が設置場所を表す
 * (独立した設置場所テーブルは無い・統合マスター §0b)。各モニタは class / grade / department / school の
 * いずれかのレベルに nullable FK で紐づく。
 *
 * ## 置き場所 (並行レーン回避)
 * `packages/db` (chokepoint) を編集せず `apps/web/lib` に置く (`dashboard-stats.ts` と同規律)。テーブルは
 * barrel から import し、`getSchoolHierarchy` (K4・packages/db) とは別用途 (こちらは運営 UI 向けの**構造**ツリーで
 * 空の枝も見せる / K4 は portal 向けのモニタ平坦列挙)。
 *
 * ## テナント分離 (ルール2)
 * `WHERE school_id = id` は**対象特定**であってテナント境界ではない。可視範囲は呼び出し接続の RLS が決める
 * (system_admin context = 全校)。手書きの role 条件は書かない (`getSchoolDetail` と同方針)。
 *
 * ## PII / 秘匿値 (ルール4)
 * モニタは設置場所ラベルと稼働メタ (alertState / lastSeenAt / monitoringEnabled) のみ扱い、`device_id`
 * (ポーリング解決キー)・MAC・signage_url・fcm_token 等の秘匿値は射影しない。
 */

type Selectable = Pick<TenantTx, "select">;
type AlertState = InferSelectModel<typeof tvDevices>["alertState"];

/** ツリー末端のモニタ (設置場所ラベル + 稼働メタ・秘匿値は持たない)。 */
export type TreeDevice = {
  id: string;
  label: string | null;
  alertState: AlertState;
  lastSeenAt: Date | null;
  monitoringEnabled: boolean;
};

/** クラス (HR)。配下に直接紐づくモニタを持つ。 */
export type TreeClass = {
  id: string;
  name: string;
  academicYear: number;
  devices: TreeDevice[];
};

/** 学年。配下のクラスと、クラス未割当 (学年レベル) のモニタを持つ。 */
export type TreeGrade = {
  id: string;
  name: string;
  classes: TreeClass[];
  devices: TreeDevice[];
};

/** 学科 (学科モード校のみ)。配下の学年と、学年未割当 (学科レベル) のモニタを持つ。 */
export type TreeDepartment = {
  id: string;
  name: string;
  grades: TreeGrade[];
  devices: TreeDevice[];
};

/**
 * 学校の階層ツリー。
 * - クラスモード: `grades` に全学年がぶら下がる (`departments` は空)。
 * - 学科モード: `departments` に学科がぶら下がり、各学科配下に学年。学科未割当の学年は `grades` に残す (異常系の保全)。
 * - `schoolDevices`: 学年/学科/クラスのいずれにも紐づかない学校レベルのモニタ (昇降口・廊下等)。
 */
export type SchoolTree = {
  departments: TreeDepartment[];
  grades: TreeGrade[];
  schoolDevices: TreeDevice[];
};

type DeptRow = { id: string; name: string; displayOrder: number };
type GradeRow = { id: string; name: string; departmentId: string | null; displayOrder: number };
type ClassRow = { id: string; name: string; gradeId: string | null; academicYear: number };
type DeviceRow = {
  id: string;
  label: string | null;
  classId: string | null;
  gradeId: string | null;
  departmentId: string | null;
  alertState: AlertState;
  lastSeenAt: Date | null;
  monitoringEnabled: boolean;
};

/** 設置場所ラベル → id の決定的順序 (getSchoolHierarchy と同方針)。 */
function compareDevice(a: TreeDevice, b: TreeDevice): number {
  return (a.label ?? "").localeCompare(b.label ?? "", "ja") || a.id.localeCompare(b.id);
}

function toTreeDevice(d: DeviceRow): TreeDevice {
  return {
    id: d.id,
    label: d.label,
    alertState: d.alertState,
    lastSeenAt: d.lastSeenAt,
    monitoringEnabled: d.monitoringEnabled,
  };
}

/** rows からツリーを **純粋に** 組み立てる (DB 非依存・テスト可能)。空の枝も保持する。 */
export function assembleSchoolTree(input: {
  departments: readonly DeptRow[];
  grades: readonly GradeRow[];
  classes: readonly ClassRow[];
  devices: readonly DeviceRow[];
}): SchoolTree {
  // モニタを最も具体的なレベルへ振り分ける (class > grade > department > school)。
  const devicesByClass = new Map<string, TreeDevice[]>();
  const devicesByGrade = new Map<string, TreeDevice[]>();
  const devicesByDept = new Map<string, TreeDevice[]>();
  const schoolDevices: TreeDevice[] = [];
  const push = (m: Map<string, TreeDevice[]>, key: string, d: TreeDevice) => {
    const list = m.get(key);
    if (list) {
      list.push(d);
    } else {
      m.set(key, [d]);
    }
  };
  for (const d of input.devices) {
    const td = toTreeDevice(d);
    if (d.classId) {
      push(devicesByClass, d.classId, td);
    } else if (d.gradeId) {
      push(devicesByGrade, d.gradeId, td);
    } else if (d.departmentId) {
      push(devicesByDept, d.departmentId, td);
    } else {
      schoolDevices.push(td);
    }
  }

  // クラスを学年ごとにまとめる (年度降順 → 名前 → id で決定的)。
  const classesByGrade = new Map<string, TreeClass[]>();
  for (const c of input.classes) {
    if (!c.gradeId) {
      continue; // 学年未割当のクラスはツリーに出さない (掲示階層外)。
    }
    const tc: TreeClass = {
      id: c.id,
      name: c.name,
      academicYear: c.academicYear,
      devices: (devicesByClass.get(c.id) ?? []).sort(compareDevice),
    };
    const list = classesByGrade.get(c.gradeId);
    if (list) {
      list.push(tc);
    } else {
      classesByGrade.set(c.gradeId, [tc]);
    }
  }
  for (const list of classesByGrade.values()) {
    list.sort((a, b) => b.academicYear - a.academicYear || a.name.localeCompare(b.name, "ja"));
  }

  // 学年を学科ごとにまとめる (displayOrder → 名前)。department_id null は top-level。
  const buildGrade = (g: GradeRow): TreeGrade => ({
    id: g.id,
    name: g.name,
    classes: classesByGrade.get(g.id) ?? [],
    devices: (devicesByGrade.get(g.id) ?? []).sort(compareDevice),
  });
  const sortedGrades = [...input.grades].sort(
    (a, b) => a.displayOrder - b.displayOrder || a.name.localeCompare(b.name, "ja"),
  );
  const gradesByDept = new Map<string, TreeGrade[]>();
  const topGrades: TreeGrade[] = [];
  for (const g of sortedGrades) {
    const tg = buildGrade(g);
    if (g.departmentId) {
      const list = gradesByDept.get(g.departmentId);
      if (list) {
        list.push(tg);
      } else {
        gradesByDept.set(g.departmentId, [tg]);
      }
    } else {
      topGrades.push(tg);
    }
  }

  const sortedDepts = [...input.departments].sort(
    (a, b) => a.displayOrder - b.displayOrder || a.name.localeCompare(b.name, "ja"),
  );
  const departmentNodes: TreeDepartment[] = sortedDepts.map((d) => ({
    id: d.id,
    name: d.name,
    grades: gradesByDept.get(d.id) ?? [],
    devices: (devicesByDept.get(d.id) ?? []).sort(compareDevice),
  }));

  return {
    departments: departmentNodes,
    grades: topGrades,
    schoolDevices: schoolDevices.sort(compareDevice),
  };
}

/**
 * 学校 1 件の階層ツリーを取得する。`WHERE school_id = id` は対象特定 (テナント境界は RLS)。
 * ソフトデリート済 (`deleted_at`) のモニタは除外する。
 */
export async function getSchoolTree(db: Selectable, schoolId: string): Promise<SchoolTree> {
  const deptRows = await db
    .select({ id: departments.id, name: departments.name, displayOrder: departments.displayOrder })
    .from(departments)
    .where(eq(departments.schoolId, schoolId));
  const gradeRows = await db
    .select({
      id: grades.id,
      name: grades.name,
      departmentId: grades.departmentId,
      displayOrder: grades.displayOrder,
    })
    .from(grades)
    .where(eq(grades.schoolId, schoolId));
  const classRows = await db
    .select({
      id: classes.id,
      name: classes.name,
      gradeId: classes.gradeId,
      academicYear: classes.academicYear,
    })
    .from(classes)
    .where(eq(classes.schoolId, schoolId));
  const deviceRows = await db
    .select({
      id: tvDevices.id,
      label: tvDevices.label,
      classId: tvDevices.classId,
      gradeId: tvDevices.gradeId,
      departmentId: tvDevices.departmentId,
      alertState: tvDevices.alertState,
      lastSeenAt: tvDevices.lastSeenAt,
      monitoringEnabled: tvDevices.monitoringEnabled,
    })
    .from(tvDevices)
    .where(and(eq(tvDevices.schoolId, schoolId), isNull(tvDevices.deletedAt)));

  return assembleSchoolTree({
    departments: deptRows,
    grades: gradeRows,
    classes: classRows,
    devices: deviceRows,
  });
}
