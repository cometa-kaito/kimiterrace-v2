import { type TenantTx, classes } from "@kimiterrace/db";
import { asc, isNull } from "drizzle-orm";
import type { TodayDailyDataScopes } from "@/lib/school-admin/hub-queries";

/**
 * エディタ着地「実画面モニタの壁」の **「その他」(非教室サイネージ) 取得層** (PR4)。
 *
 * 「その他」= `grade_id IS NULL` のクラス (玄関・廊下・職員室前などクラス内以外の設置場所、schema
 * `classes.ts` 参照)。学校管理ハブの `getSchoolHierarchy` は学年ツリーを組むため `grade_id IS NULL` の
 * クラスを除外する。エディタは通常クラスと同じく「その他」も壁に出して全ロールが中身 (daily_data) を編集
 * できるようにしたいので、**エディタ自身のデータ層**でこれらを別途読む (hub-queries は別 PR 所有のため触らない)。
 *
 * 所属学科は `classes.department_id` を直接持つ (通常クラスは grade 経由だが「その他」はその経路を辿れない)。
 * 学校直下の「その他」は `department_id` が NULL。
 *
 * **RLS (ルール2)**: `withSession` の自校 tx 内で呼ぶ。`classes` の SELECT は `app.current_school_id` で
 * 自校に限定される (手書き WHERE school_id は書かない、DB レベルで強制)。
 */

/** 壁に出す「その他」クラス 1 件 (所属学科 id 付き)。学校直下は departmentId=null。 */
export type OtherClass = {
  id: string;
  name: string;
  /** 所属学科 (`classes.department_id`)。学校直下の「その他」は null。 */
  departmentId: string | null;
};

/**
 * 自校の「その他」(grade_id IS NULL) クラスを名前順で取得する。学年に属さない設置場所のみ。
 * 学科ごと / 学校直下のグルーピングは呼び出し側 (page) が `departmentId` で行う。
 */
export async function getOtherClasses(tx: TenantTx): Promise<OtherClass[]> {
  return await tx
    .select({
      id: classes.id,
      name: classes.name,
      departmentId: classes.departmentId,
    })
    .from(classes)
    .where(isNull(classes.gradeId))
    .orderBy(asc(classes.name));
}

/**
 * 「その他」クラスが本日サイネージに掲示中の中身を持つかを判定する純関数。
 *
 * `computeTodayActiveClasses` (hub-queries) は学年ツリーを辿るため「その他」(grade_id NULL) を扱えない。
 * 「その他」のサイネージ階層フォールバックは class → department → school (grade 段はスキップ、
 * `effective-daily-data.ts` の `resolveClassHierarchy` と同規約) なので、本日 active = 自クラス scope /
 * 親学科 scope (department_id がある場合) / 学校 scope のいずれかに中身ありで判定する。
 *
 * @param scopes 本日サイネージに掲示中の中身を持つ scope 集合 (`getTodayDailyDataScopes`)。
 * @returns Record<classId, boolean> (serializable・client へ素通し可)。
 */
export function computeTodayActiveOtherClasses(
  scopes: TodayDailyDataScopes,
  others: OtherClass[],
): Record<string, boolean> {
  const deptSet = new Set(scopes.departmentIds);
  const classSet = new Set(scopes.classIds);
  const out: Record<string, boolean> = {};
  for (const c of others) {
    out[c.id] =
      scopes.school || classSet.has(c.id) || (c.departmentId ? deptSet.has(c.departmentId) : false);
  }
  return out;
}
