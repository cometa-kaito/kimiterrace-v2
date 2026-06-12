import {
  type TenantTx,
  classes,
  configKind,
  departments,
  grades,
  hierarchyScope,
  schoolConfigs,
  schools,
} from "@kimiterrace/db";
import {
  type InferSelectModel,
  type SQL,
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  or,
  sql,
} from "drizzle-orm";
import {
  type ListParams,
  escapeLike,
  pageWindow,
} from "@/app/admin/_components/datalist/list-params";

/**
 * UIUX-03: 学校設定ビューア (`/admin/system/school-configs`) のページング/検索/ソート対応 SELECT 層。
 * `audit-log-list.ts` / `event-log.ts` と同構造 (共通 DataList 基盤)。
 *
 * ## 置き場所 (並行レーン回避)
 * `packages/db` (chokepoint) を編集せず `apps/web/lib` に置く。テーブル/enum は barrel から
 * import し、行型は schema 由来 (`InferSelectModel<typeof schoolConfigs>`、ルール3)。
 *
 * ## テナント分離 (ルール2 / ADR-019)
 * `school_configs` は tenant_isolation + system_admin_full_access policy (migration 0006) が守る。
 * WHERE に school_id / role を**テナント境界としては書かない** — 可視範囲は呼出側 (`withSession`)
 * が張る RLS context が決める (system_admin=全校)。`filters.school` は system_admin が任意校に
 * 絞る**検索条件**であって境界ではない (event-log.ts と同位置づけ)。
 *
 * ## 検索 (q)
 * 学校名 / 対象 (学年・学科・クラス) 名に加え、`value` (jsonb) を `::text` 化して ilike 部分一致
 * させる (audit-log-list の diff 検索と同方針。「この時間帯を含む設定はどれか」を引ける)。
 * value は設定値 (時間帯・表示設定等) で生徒 PII を含まない設計だが、表示は mask.ts の
 * `formatMaskedJson` を通す (管理ビューア統一作法)。
 */

/** SELECT (+ kind の selectDistinct) だけできれば良い。 */
type Selectable = Pick<TenantTx, "select" | "selectDistinct">;

/** ソート可能列の allowlist。`parseListParams` の sortKeys と ORDER BY を 1 箇所で対応させる。 */
export const SCHOOL_CONFIG_SORT_COLUMNS = {
  updatedAt: schoolConfigs.updatedAt,
  schoolName: schools.name,
  kind: schoolConfigs.kind,
} as const;

export const SCHOOL_CONFIG_SORT_KEYS = Object.keys(SCHOOL_CONFIG_SORT_COLUMNS) as readonly string[];

/** `hierarchy_scope` enum の値域 (school/grade/class/department)。schema が単一ソース (ルール3)。 */
export const HIERARCHY_SCOPE_VALUES = hierarchyScope.enumValues;

/** 設定スコープ。enum 値とズレるとコンパイルで検出される。 */
export type HierarchyScopeValue = (typeof HIERARCHY_SCOPE_VALUES)[number];

/** `config_kind` enum の値域 (display_settings/quiet_hours/schedule_templates)。 */
export const CONFIG_KIND_VALUES = configKind.enumValues;

/** 設定種別。enum 値とズレるとコンパイルで検出される。 */
export type ConfigKindValue = (typeof CONFIG_KIND_VALUES)[number];

type SchoolConfigRow = InferSelectModel<typeof schoolConfigs>;

/** 一覧 1 行。schema 由来の射影 + JOIN した学校名・対象 (学年/学科/クラス) 名。 */
export type SchoolConfigListEntry = Pick<
  SchoolConfigRow,
  | "id"
  | "schoolId"
  | "scope"
  | "gradeId"
  | "departmentId"
  | "classId"
  | "kind"
  | "value"
  | "updatedAt"
> & {
  schoolName: string;
  gradeName: string | null;
  departmentName: string | null;
  className: string | null;
};

/** 一覧 1 ページ分 + 総件数。 */
export type SchoolConfigListPage = { rows: SchoolConfigListEntry[]; total: number };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * `filters.school` を uuid として検証する。非該当はフィルタなし (null)。
 * 「uuid 形式でない値を SQL に渡さない」ための形式検証であって**テナント境界ではない** —
 * 境界は RLS が DB レベルで守る (ルール2、event-log.ts と同パターン)。
 */
export function parseSchoolFilter(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const normalized = value.toLowerCase();
  return UUID_RE.test(normalized) ? normalized : null;
}

/** URL 由来の kind フィルタを enum 値域に検証する (範囲外は黙って無視、URL は外部入力)。 */
export function parseConfigKindFilter(value: string | undefined): ConfigKindValue | null {
  if (value !== undefined && (CONFIG_KIND_VALUES as readonly string[]).includes(value)) {
    return value as ConfigKindValue;
  }
  return null;
}

/**
 * 学校設定を検索 (学校名/対象名/value 全文の部分一致)・学校/kind フィルタ・列ソート・ページングで
 * 取得する。schools は notNull FK の innerJoin (件数を変えない)。grades/departments/classes は
 * nullable FK のため leftJoin で対象名を解決する (scope='school' の行は全 NULL)。
 * 同値ソートでも順序が安定するよう id を最終タイブレークに付ける。
 */
export async function listSchoolConfigPage(
  db: Selectable,
  params: ListParams,
): Promise<SchoolConfigListPage> {
  const conditions: SQL[] = [];
  if (params.q) {
    const pattern = `%${escapeLike(params.q)}%`;
    const match = or(
      ilike(schools.name, pattern),
      ilike(grades.name, pattern),
      ilike(departments.name, pattern),
      ilike(classes.name, pattern),
      // value (jsonb) は text 化して全文部分一致 (モジュール doc「検索 (q)」参照)。
      ilike(sql`${schoolConfigs.value}::text`, pattern),
    );
    if (match) {
      conditions.push(match);
    }
  }
  // 検索条件としての学校絞り込み (テナント境界は RLS、parseSchoolFilter の doc 参照)。
  const school = parseSchoolFilter(params.filters.school);
  if (school) {
    conditions.push(eq(schoolConfigs.schoolId, school));
  }
  const kind = parseConfigKindFilter(params.filters.kind);
  if (kind) {
    conditions.push(eq(schoolConfigs.kind, kind));
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const sortColumn =
    SCHOOL_CONFIG_SORT_COLUMNS[params.sort as keyof typeof SCHOOL_CONFIG_SORT_COLUMNS] ??
    schoolConfigs.updatedAt;
  const orderBy =
    params.dir === "asc"
      ? [asc(sortColumn), asc(schools.name), asc(schoolConfigs.id)]
      : [desc(sortColumn), asc(schools.name), asc(schoolConfigs.id)];
  const { limit, offset } = pageWindow(params);

  const [rows, totals] = await Promise.all([
    db
      .select({
        id: schoolConfigs.id,
        schoolId: schoolConfigs.schoolId,
        schoolName: schools.name,
        scope: schoolConfigs.scope,
        gradeId: schoolConfigs.gradeId,
        gradeName: grades.name,
        departmentId: schoolConfigs.departmentId,
        departmentName: departments.name,
        classId: schoolConfigs.classId,
        className: classes.name,
        kind: schoolConfigs.kind,
        value: schoolConfigs.value,
        updatedAt: schoolConfigs.updatedAt,
      })
      .from(schoolConfigs)
      .innerJoin(schools, eq(schoolConfigs.schoolId, schools.id))
      .leftJoin(grades, eq(schoolConfigs.gradeId, grades.id))
      .leftJoin(departments, eq(schoolConfigs.departmentId, departments.id))
      .leftJoin(classes, eq(schoolConfigs.classId, classes.id))
      .where(where)
      .orderBy(...orderBy)
      .limit(limit)
      .offset(offset),
    // count にも一覧と同じ JOIN を張る (q 条件が JOIN 先の name 列を参照するため)。
    // innerJoin は notNull FK、leftJoin は PK 結合で行数を変えないため件数は一致する。
    db
      .select({ value: count() })
      .from(schoolConfigs)
      .innerJoin(schools, eq(schoolConfigs.schoolId, schools.id))
      .leftJoin(grades, eq(schoolConfigs.gradeId, grades.id))
      .leftJoin(departments, eq(schoolConfigs.departmentId, departments.id))
      .leftJoin(classes, eq(schoolConfigs.classId, classes.id))
      .where(where),
  ]);

  return { rows, total: totals[0]?.value ?? 0 };
}

/**
 * kind フィルタの選択肢用に、school_configs に**実在する** kind を distinct で返す
 * (audit-log-list の `listAuditLogTableNames` と同パターン)。値域は config_kind enum の
 * 高々 3 値 (ページング不要)。
 */
export async function listSchoolConfigKinds(db: Selectable): Promise<ConfigKindValue[]> {
  const rows = await db
    .selectDistinct({ kind: schoolConfigs.kind })
    .from(schoolConfigs)
    .orderBy(asc(schoolConfigs.kind));
  return rows.map((r) => r.kind);
}
