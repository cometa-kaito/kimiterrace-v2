import { readQuietRanges } from "@/lib/school-admin/quiet-hours-core";
import { type TenantTx, classes, dailyData, getClassConfigValue } from "@kimiterrace/db";
import { type InferSelectModel, and, eq, or } from "drizzle-orm";

/**
 * サイネージの実効日次データ解決 (#48-E1 / #191)。
 *
 * V1 の `master_daily_data`(学校デフォルト) → 学年 → クラスの階層を、あるクラス視点で 1 日分に
 * マージする。広告 (`effective_ads_per_class` VIEW, #48-F) と対をなす「日次セクションの階層マージ」。
 *
 * **マージ規約 (per-field 精度優先)**: schedules / notices / assignments / quiet_hours の各セクション
 * ごとに、**最も具体的な scope で非空のものを採用** (class > grade > school)。クラスがその
 * セクションを持てばクラス、無ければ学年、無ければ学校デフォルトに段階フォールバックする。
 * (V1 の「クラス個別が無ければ学校全体デフォルトを表示」挙動を per-field で一般化。)
 *
 * **静粛時間の二段フォールバック (#191、#48-J-2 配線)**: quiet_hours は他セクションと違い「その日の
 * override」(`daily_data.quiet_hours`) と「クラスの永続既定」(`school_configs` scope=class
 * kind='quiet_hours') の 2 ソースを持つ。優先順は **当日 daily_data の階層マージ結果 (override) >
 * school_configs クラス既定 (default)** ─ 広告の `effective_ads_per_class` が持つ「上書き→既定」と
 * 同思想。daily_data 由来の quiet_hours が全 scope 空のときだけ school_configs の既定に落とす
 * (`mergeDailySections` の `quietHoursFallback` 引数)。
 *
 * **値形ブリッジ (#48-J-2)**: `daily_data.quiet_hours` は時間帯の**配列**だが、`school_configs.value`
 * は JSONB の**オブジェクト** `{ ranges: [{ start, end }] }`。`readQuietRanges` で `.ranges` を防御的に
 * 取り出して配列形に揃え、マージ後の `MergedSection.items` の形 (配列) を一貫させる (型の単一ソースは
 * `quiet-hours-core.ts`、ルール3)。
 *
 * **テナント分離 (CLAUDE.md ルール2)**: 本関数は RLS コンテキスト設定済の `withSession` /
 * `withTenantContext` トランザクション内で呼ぶこと。`classes` / `daily_data` / `school_configs` の
 * SELECT は `app.current_school_id` により DB レベルで自校に限定される。`school_configs` の
 * `tenant_isolation` policy は `daily_data` と同一 (school_id 一致のみ、ロール非依存、migration
 * 0006) なので、サイネージの匿名コンテキスト (school_id のみ set、role/userId 無し) でも既存の
 * daily_data と同じ経路で読める ─ 新規 policy / SECURITY DEFINER は不要。`db` は非 BYPASSRLS ロール
 * (kimiterrace_app)。
 */

/**
 * daily_data の 1 行のうちマージに必要な部分。`daily_data` スキーマから `Pick` で派生し、
 * `scope` の値域も `hierarchy_scope` enum と単一ソースにする (CLAUDE.md ルール3、手書き複製しない)。
 */
export type DailyScopeRow = Pick<
  InferSelectModel<typeof dailyData>,
  "scope" | "schedules" | "notices" | "assignments" | "quietHours"
>;

/** マージ採用元になりうる scope (department はサイネージ表示対象外なので含めない)。 */
type RenderableScope = "school" | "grade" | "class";

/** マージ後の 1 セクション。`source` は採用元 scope (全 scope 空なら null)。 */
export type MergedSection = {
  items: unknown[];
  source: RenderableScope | null;
};

export type EffectiveDailyData = {
  date: string;
  schedules: MergedSection;
  notices: MergedSection;
  assignments: MergedSection;
  quietHours: MergedSection;
};

type SectionField = "schedules" | "notices" | "assignments" | "quietHours";

/** 配列かつ非空なら中身を返す。それ以外 (未定義/空/非配列) は null。 */
function nonEmptyArray(value: unknown): unknown[] | null {
  return Array.isArray(value) && value.length > 0 ? value : null;
}

/**
 * scope 別 (class/grade/school) の daily_data 行から、セクションごとに精度優先でマージする。
 * **純粋関数** — DB 非依存でテスト可能。department scope はサイネージ表示対象外として無視する。
 *
 * @param quietHoursFallback school_configs (scope=class, kind='quiet_hours') 由来のクラス永続既定
 *   (`{ ranges }` から取り出した配列、#191)。daily_data の quiet_hours が全 scope 空のときだけ
 *   ここに段階フォールバックする ("当日 override > クラス既定" の優先順)。null/空なら最終的に空。
 *   採用時の `MergedSection.source` は `class` (= クラス由来の既定)。
 */
export function mergeDailySections(
  date: string,
  rows: DailyScopeRow[],
  quietHoursFallback: unknown[] | null = null,
): EffectiveDailyData {
  const byScope = {
    class: rows.find((r) => r.scope === "class") ?? null,
    grade: rows.find((r) => r.scope === "grade") ?? null,
    school: rows.find((r) => r.scope === "school") ?? null,
  };

  const pick = (field: SectionField): MergedSection => {
    for (const scope of ["class", "grade", "school"] as const) {
      const row = byScope[scope];
      const items = row ? nonEmptyArray(row[field]) : null;
      if (items) {
        return { items, source: scope };
      }
    }
    return { items: [], source: null };
  };

  // 静粛時間は daily_data の階層マージ結果 (当日 override) を最優先し、それが空のときだけ
  // school_configs のクラス既定 (永続) に落とす。既定由来は「クラス設定」なので source=class。
  const pickQuietHours = (): MergedSection => {
    const override = pick("quietHours");
    if (override.source !== null) {
      return override;
    }
    const fallback = nonEmptyArray(quietHoursFallback);
    return fallback ? { items: fallback, source: "class" } : { items: [], source: null };
  };

  return {
    date,
    schedules: pick("schedules"),
    notices: pick("notices"),
    assignments: pick("assignments"),
    quietHours: pickQuietHours(),
  };
}

/**
 * 指定クラスの指定日の実効日次データを取得する。クラスが存在しない/別テナントで不可視なら null。
 *
 * @param tx      RLS コンテキスト設定済トランザクション (withSession 内)
 * @param classId 対象クラス
 * @param date    YYYY-MM-DD
 */
export async function getEffectiveDailyData(
  tx: TenantTx,
  classId: string,
  date: string,
): Promise<EffectiveDailyData | null> {
  const cls = (
    await tx
      .select({ gradeId: classes.gradeId, schoolId: classes.schoolId })
      .from(classes)
      .where(eq(classes.id, classId))
      .limit(1)
  )[0];
  if (!cls) {
    return null;
  }

  const rows = await tx
    .select({
      scope: dailyData.scope,
      schedules: dailyData.schedules,
      notices: dailyData.notices,
      assignments: dailyData.assignments,
      quietHours: dailyData.quietHours,
    })
    .from(dailyData)
    .where(
      and(
        eq(dailyData.date, date),
        or(
          and(eq(dailyData.scope, "class"), eq(dailyData.classId, classId)),
          // 学年未割当 (grade_id NULL) のクラスは学年スコープを引かない。
          cls.gradeId
            ? and(eq(dailyData.scope, "grade"), eq(dailyData.gradeId, cls.gradeId))
            : undefined,
          eq(dailyData.scope, "school"),
        ),
      ),
    );

  // クラスの永続既定 (school_configs scope=class kind='quiet_hours')。当日 daily_data に
  // quiet_hours の override が無いときのフォールバックに使う (#191、優先順は override > 既定)。
  // 読み取りは同じ RLS コンテキスト (app.current_school_id) で自校に限定される (ルール2)。
  // 値は `{ ranges: [...] }` オブジェクトなので readQuietRanges で配列形に揃える (値形ブリッジ)。
  const quietHoursConfig = await getClassConfigValue(tx, classId, "quiet_hours");
  const quietHoursFallback = readQuietRanges(quietHoursConfig);

  return mergeDailySections(date, rows, quietHoursFallback);
}
