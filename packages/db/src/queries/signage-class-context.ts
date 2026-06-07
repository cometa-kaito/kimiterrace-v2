import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { classes } from "../schema/classes.js";
import { departments } from "../schema/departments.js";
import { grades } from "../schema/grades.js";

/**
 * #243 (②UI-UX): 公開サイネージのヘッダーに「学科・学年・クラス」を出して**どのサイネージか識別できる**
 * ようにするための、クラス文脈（学科名 / 学年名 / クラス名）読み取り層。**SELECT のみ**。
 *
 * ## テナント分離（ルール2 / ADR-019）
 * `school_id` 条件を**書かない**。サイネージ経路は `getSignageDisplayData` が `withTenantContext`
 * （`app.current_school_id` のみ）で開いた tx 内から呼ぶため、`classes` / `grades` / `departments` の
 * `tenant_isolation` が自校行に限定する（手書き WHERE school_id なし）。`classId` は対象特定の条件であって
 * テナント境界ではない。
 *
 * ## PII 非格納（ルール4）
 * 返すのはクラス・学年・学科の**名称のみ**（設置場所相当の公開情報）。個人を識別する情報は含まない。
 *
 * grade / department は学校の階層モードにより未設定になりうるため LEFT JOIN（無ければ null）。
 */

type Selectable = Pick<PostgresJsDatabase, "select">;

/** サイネージ識別用のクラス文脈（いずれも未設定なら null）。 */
export type SignageClassContext = {
  className: string | null;
  gradeName: string | null;
  departmentName: string | null;
};

/**
 * 指定クラスの「学科名 / 学年名 / クラス名」を取得する。可視範囲は RLS（自校）が決める。
 * 不可視 / 不存在なら全て null（サイネージは識別表示を出さないだけで盤面は壊さない）。
 */
export async function getSignageClassContext(
  db: Selectable,
  classId: string,
): Promise<SignageClassContext> {
  const rows = await db
    .select({
      className: classes.name,
      gradeName: grades.name,
      departmentName: departments.name,
    })
    .from(classes)
    .leftJoin(grades, eq(classes.gradeId, grades.id))
    .leftJoin(departments, eq(grades.departmentId, departments.id))
    .where(eq(classes.id, classId))
    .limit(1);
  const r = rows[0];
  return {
    className: r?.className ?? null,
    gradeName: r?.gradeName ?? null,
    departmentName: r?.departmentName ?? null,
  };
}
