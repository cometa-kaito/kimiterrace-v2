import { type TenantTx, schools } from "@kimiterrace/db";
import type { SchoolSummary } from "@kimiterrace/db";
import { type SQL, and, asc, count, desc, eq, gte, ilike, lt, or } from "drizzle-orm";
import {
  type ListParams,
  dateRangeBounds,
  escapeLike,
  pageWindow,
} from "@/app/_components/datalist/list-params";

/**
 * UIUX-03 PR1: 学校一覧のページング/検索/ソート対応 SELECT 層。
 *
 * ## 置き場所 (並行レーン回避)
 * `packages/db` (chokepoint) を編集せず `apps/web/lib` に置く (`effect-comment-stats.ts` と同じ
 * 規律)。テーブルは barrel から import し、型は schema 由来 (`SchoolSummary`、ルール3)。
 *
 * ## テナント分離 (ルール2)
 * `school_id` / role の WHERE は書かない — 呼び出し側 (`withSession`) が張る RLS コンテキストが
 * 可視範囲を決める (system_admin=全校)。WHERE は検索条件のみ。
 */

type Selectable = Pick<TenantTx, "select">;

/** ソート可能列の allowlist。`parseListParams` の sortKeys と ORDER BY を 1 箇所で対応させる。 */
export const SCHOOL_SORT_COLUMNS = {
  prefecture: schools.prefecture,
  name: schools.name,
  code: schools.code,
  createdAt: schools.createdAt,
} as const;

export const SCHOOL_SORT_KEYS = Object.keys(SCHOOL_SORT_COLUMNS) as readonly string[];

/** 一覧 1 ページ分 + 総件数。 */
export type SchoolListPage = { rows: SchoolSummary[]; total: number };

/**
 * 学校一覧を検索 (校名/コード/都道府県の部分一致)・登録日範囲・列ソート・ページングで取得する。
 * 同値ソートでも順序が安定するよう id を最終タイブレークに付ける。
 */
export async function listSchoolsPage(db: Selectable, params: ListParams): Promise<SchoolListPage> {
  const conditions: SQL[] = [];
  if (params.q) {
    const pattern = `%${escapeLike(params.q)}%`;
    const match = or(
      ilike(schools.name, pattern),
      ilike(schools.code, pattern),
      ilike(schools.prefecture, pattern),
    );
    if (match) {
      conditions.push(match);
    }
  }
  const { since, untilExclusive } = dateRangeBounds(params);
  if (since) {
    conditions.push(gte(schools.createdAt, since));
  }
  if (untilExclusive) {
    conditions.push(lt(schools.createdAt, untilExclusive));
  }
  if (params.filters.mode === "class" || params.filters.mode === "department") {
    conditions.push(eq(schools.hierarchyMode, params.filters.mode));
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const sortColumn =
    SCHOOL_SORT_COLUMNS[params.sort as keyof typeof SCHOOL_SORT_COLUMNS] ?? schools.createdAt;
  const orderBy =
    params.dir === "asc" ? [asc(sortColumn), asc(schools.id)] : [desc(sortColumn), asc(schools.id)];
  const { limit, offset } = pageWindow(params);

  const [rows, totals] = await Promise.all([
    db
      .select({
        id: schools.id,
        name: schools.name,
        prefecture: schools.prefecture,
        code: schools.code,
        hierarchyMode: schools.hierarchyMode,
        createdAt: schools.createdAt,
      })
      .from(schools)
      .where(where)
      .orderBy(...orderBy)
      .limit(limit)
      .offset(offset),
    db.select({ value: count() }).from(schools).where(where),
  ]);

  return { rows, total: totals[0]?.value ?? 0 };
}
