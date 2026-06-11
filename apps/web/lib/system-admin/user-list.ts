import { type StaffDirectoryEntry, type TenantTx, schools, users } from "@kimiterrace/db";
import {
  type InferSelectModel,
  type SQL,
  and,
  asc,
  count,
  countDistinct,
  desc,
  eq,
  gte,
  ilike,
  lt,
  or,
  sql,
} from "drizzle-orm";
import {
  type ListParams,
  dateRangeBounds,
  escapeLike,
  pageWindow,
} from "@/app/admin/_components/datalist/list-params";

/**
 * UIUX-03: 教職員一覧 (`/admin/system/users`) のページング/検索/ソート対応 SELECT 層。
 * `school-list.ts` と同構造 (共通 DataList 基盤の 2 例目)。
 *
 * ## 置き場所 (並行レーン回避)
 * `packages/db` (chokepoint) を編集せず `apps/web/lib` に置く (`school-list.ts` と同じ規律)。
 * テーブルは barrel から import し、型は schema 由来 (`StaffDirectoryEntry` + `InferSelectModel`、ルール3)。
 *
 * ## テナント分離 (ルール2)
 * `school_id` / role の **テナント境界 WHERE は書かない** — 呼び出し側 (`withSession`) が張る RLS
 * コンテキストが可視範囲を決める (system_admin=全校)。`role = 'school_admin'` は**対象絞り込み**で
 * テナント境界ではない (packages/db `listAllStaff` の `role IN (教職員)` と同位置づけ):
 * - 教員アカウント概念の撤去 (2026-06-10、ADR-032 系統A): role=teacher は学校共通ログインの
 *   plumbing 行のため一覧に出さない (行アクションの無効化トグル誤操作も防ぐ)。
 * - 生徒・保護者は匿名設計で一覧対象外 (PII 露出面の最小化、ルール4)。
 *
 * ## PII (ルール4)
 * `email` は**検索条件にのみ**使い射影しない (一覧の表示は 表示名/ロール/状態/所属校/登録日 のみ。
 * 検索ヒットは内容を露出せず、system_admin がメールアドレスから対象アカウントを特定する用途)。
 */

type Selectable = Pick<TenantTx, "select">;

/** ソート可能列の allowlist。`parseListParams` の sortKeys と ORDER BY を 1 箇所で対応させる。 */
export const STAFF_SORT_COLUMNS = {
  schoolName: schools.name,
  displayName: users.displayName,
  isActive: users.isActive,
  createdAt: users.createdAt,
} as const;

export const STAFF_SORT_KEYS = Object.keys(STAFF_SORT_COLUMNS) as readonly string[];

/** 一覧 1 行。全校横断ディレクトリ (`StaffDirectoryEntry`) + 登録日 (schema 由来、ルール3)。 */
export type StaffListEntry = StaffDirectoryEntry &
  Pick<InferSelectModel<typeof users>, "createdAt">;

/**
 * 一覧 1 ページ分 + ヘッダ集計。`activeTotal` / `schoolTotal` はページ内ではなく**検索条件で絞った
 * 全体**に対する集計 (従来ヘッダの「N 校 / 稼働 M / 全 L 名」をページングしても保つため)。
 */
export type StaffListPage = {
  rows: StaffListEntry[];
  total: number;
  activeTotal: number;
  schoolTotal: number;
};

/**
 * 教職員 (学校管理者) 一覧を検索 (表示名/メール/学校名の部分一致)・状態フィルタ・登録日範囲・
 * 列ソート・ページングで取得する。同値ソートでも順序が安定するよう id を最終タイブレークに付ける。
 * `INNER JOIN schools` は `users.school_id` (notNull FK) で常に 1 校に対応し、件数を変えない。
 */
export async function listStaffPage(db: Selectable, params: ListParams): Promise<StaffListPage> {
  // 対象絞り込み (テナント境界ではない、モジュール doc 参照)。検索条件はこの後ろに AND で足す。
  const conditions: SQL[] = [eq(users.role, "school_admin")];
  if (params.q) {
    const pattern = `%${escapeLike(params.q)}%`;
    const match = or(
      ilike(users.displayName, pattern),
      ilike(users.email, pattern),
      ilike(schools.name, pattern),
    );
    if (match) {
      conditions.push(match);
    }
  }
  const { since, untilExclusive } = dateRangeBounds(params);
  if (since) {
    conditions.push(gte(users.createdAt, since));
  }
  if (untilExclusive) {
    conditions.push(lt(users.createdAt, untilExclusive));
  }
  // 状態 (稼働中 / 無効) セレクト。boolean 列なので "true" / "false" の 2 値のみ受け付ける。
  if (params.filters.active === "true" || params.filters.active === "false") {
    conditions.push(eq(users.isActive, params.filters.active === "true"));
  }
  const where = and(...conditions);

  const sortColumn =
    STAFF_SORT_COLUMNS[params.sort as keyof typeof STAFF_SORT_COLUMNS] ?? schools.name;
  const orderBy =
    params.dir === "asc" ? [asc(sortColumn), asc(users.id)] : [desc(sortColumn), asc(users.id)];
  const { limit, offset } = pageWindow(params);

  const [rows, totals] = await Promise.all([
    db
      .select({
        id: users.id,
        displayName: users.displayName,
        role: users.role,
        isActive: users.isActive,
        schoolId: users.schoolId,
        schoolName: schools.name,
        createdAt: users.createdAt,
      })
      .from(users)
      .innerJoin(schools, eq(users.schoolId, schools.id))
      .where(where)
      .orderBy(...orderBy)
      .limit(limit)
      .offset(offset),
    db
      .select({
        value: count(),
        // CASE WHEN の非 NULL 行だけ数える = 稼働中 (is_active) の件数。
        active: count(sql`case when ${users.isActive} then 1 end`),
        schools: countDistinct(users.schoolId),
      })
      .from(users)
      .innerJoin(schools, eq(users.schoolId, schools.id))
      .where(where),
  ]);

  return {
    rows,
    total: totals[0]?.value ?? 0,
    activeTotal: totals[0]?.active ?? 0,
    schoolTotal: totals[0]?.schools ?? 0,
  };
}
