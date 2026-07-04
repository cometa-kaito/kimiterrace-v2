import {
  ASSIGNMENT_GRACE_DAYS,
  type NoticeItem,
  type PinnedNoticeRow,
} from "@/lib/editor/notice-assignment-core";
import { readQuietRanges } from "@/lib/school-admin/quiet-hours-core";
import { type TenantTx, classes, dailyData, getClassConfigValue, grades } from "@kimiterrace/db";
import { type InferSelectModel, and, eq, gte, inArray, lte, or, sql } from "drizzle-orm";

/**
 * サイネージの実効日次データ解決 (#48-E1 / #191)。
 *
 * V1 の `master_daily_data`(学校デフォルト) → 学年 → クラスの階層を、あるクラス視点で 1 日分に
 * マージする。広告 (`effective_ads_per_class` VIEW, #48-F) と対をなす「日次セクションの階層マージ」。
 *
 * **マージ規約 (per-field 精度優先)**: schedules / notices / assignments / quiet_hours の各セクション
 * ごとに、**最も具体的な scope で非空のものを採用** (class > grade > department > school)。クラスがその
 * セクションを持てばクラス、無ければ学年、無ければ学科、無ければ学校デフォルトに段階フォールバックする。
 * (V1 の「クラス個別が無ければ学校全体デフォルトを表示」挙動を per-field で一般化。段A-2 で「学科全体」
 * 編集をサイネージに反映するため department scope をマージ対象に追加。クラスの所属学科は
 * `grades.department_id` 経由で解決する。)
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

/** マージ採用元になりうる scope (精度: class > grade > department > school)。段A-2 で department を追加。 */
type RenderableScope = "school" | "department" | "grade" | "class";

/** マージの精度優先順 (具体 → 一般)。`pick` / `pickScheduleForDate` がこの順で最初の非空を採用する。 */
const SCOPE_PRECEDENCE = ["class", "grade", "department", "school"] as const;

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
 * scope 別 (class/grade/department/school) の daily_data 行から、セクションごとに精度優先でマージする。
 * **純粋関数** — DB 非依存でテスト可能。優先順は class > grade > department > school (段A-2 で department
 * を追加、学科全体編集をサイネージに反映)。
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
    department: rows.find((r) => r.scope === "department") ?? null,
    school: rows.find((r) => r.scope === "school") ?? null,
  };

  const pick = (field: SectionField): MergedSection => {
    for (const scope of SCOPE_PRECEDENCE) {
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
 * サイネージの遡及読み取り窓 (日数)。連絡(最大表示日数 14)・提出物(期限前後)の活性判定に十分な過去日数。
 * 学校管理ハブの「本日の掲示状態」(`hub-queries.ts`) も同じ窓でサイネージ実表示に整合させるため export する。
 */
export const EFFECTIVE_LOOKBACK_DAYS = 31;

const MS_PER_DAY = 86_400_000;

function dateToUtcMs(d: string): number {
  const parts = d.split("-");
  return Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
}

/** YYYY-MM-DD 間の暦日差 (to - from)。UTC 基準で TZ/DST 非依存。 */
export function daysBetween(from: string, to: string): number {
  return Math.round((dateToUtcMs(to) - dateToUtcMs(from)) / MS_PER_DAY);
}

/** YYYY-MM-DD に n 日加算して YYYY-MM-DD を返す (遡及窓の開始日計算)。 */
export function addDays(date: string, n: number): string {
  const dt = new Date(dateToUtcMs(date) + n * MS_PER_DAY);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const day = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * 連絡が today に表示中か。入力日 (rowDate) から displayDays 日間 (既定 1=入力日のみ)。
 * **固定表示 (pinned・F-C §5.4)**: `pinned === true` の連絡は入力日以降**ずっと**活性 (displayDays 非依存)。
 * 本 helper は盤面 (mergeWindowedSection) と学校管理ハブ (hub-queries の isWindowRowActiveToday) が共有する
 * 活性判定の単一ソースなので、pinned の意味は両読み手へ同時に効く (§11-7: 片側だけ直さない)。
 */
export function isNoticeActive(item: unknown, rowDate: string, today: string): boolean {
  const rec =
    typeof item === "object" && item !== null
      ? (item as { displayDays?: unknown; pinned?: unknown })
      : null;
  const diff = daysBetween(rowDate, today);
  if (rec?.pinned === true) {
    return diff >= 0;
  }
  const dd = typeof rec?.displayDays === "number" ? rec.displayDays : 1;
  return diff >= 0 && diff < dd;
}

/**
 * クラス直の固定行（{@link PinnedNoticeRow}・getClassPinnedNoticeRows の結果）から、**対象日以外の日に
 * 入力された・対象日に活性な pinned 項目**を、実盤面のマージ順（入力日昇順・{@link mergeWindowedSection}
 * と同じ）で平坦化する（2026-07-04 Reviewer MEDIUM-2）。
 *
 * エディタ WYSIWYG プレビュー（editor-board-preview.ts）は対象日の draft で notices を**全置換**するため、
 * 他日入力の pinned（実 TV には窓マージ済みで出ている）がプレビューから消えて実機と不一致になる。本 helper
 * の結果を draft の**前に連結**すると実盤面の合成（class scope 採用時: 窓内の活性項目を入力日昇順・対象日の
 * 行が末尾）と一致する。活性判定は単一ソース {@link isNoticeActive} を使う（第 3 の合成実装を作らない）。
 * 対象日の行は除外する（その pinned は draft＝NoticeEditor の「ずっと」行として既に含まれる・二重表示防止）。
 * 未来日の行は {@link isNoticeActive} が非活性と判定する（入力日以降のみ表示）。**純関数**。
 */
export function activePinnedNoticeItemsOutsideDate(
  rows: readonly PinnedNoticeRow[],
  date: string,
): NoticeItem[] {
  return [...rows]
    .filter((r) => r.date !== date)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .flatMap((r) => r.items.filter((i) => i.pinned === true && isNoticeActive(i, r.date, date)));
}

/** 提出物が today に表示中か。期限 + ASSIGNMENT_GRACE_DAYS 日まで表示し、以後は消える。 */
export function isAssignmentActive(item: unknown, today: string): boolean {
  const deadline =
    typeof item === "object" && item !== null ? (item as { deadline?: unknown }).deadline : null;
  if (typeof deadline !== "string") {
    return false;
  }
  return daysBetween(deadline, today) <= ASSIGNMENT_GRACE_DAYS;
}

/** 遡及窓の 1 行 (DailyScopeRow + 入力日)。notices/assignments の活性判定に入力日が要る。 */
type DailyWindowRow = DailyScopeRow & { date: string };

/**
 * 遡及窓の行から、scope 精度優先で「today に活性な」notices/assignments をマージする。最も具体的な scope に
 * 活性項目が 1 件でもあればその scope を採用 (既存の per-field 最具体勝ち規約を多日へ拡張)。採用 scope の
 * 活性項目を入力日昇順で集め、提出物は期限昇順に整える。**純関数**。
 */
function mergeWindowedSection(
  rows: DailyWindowRow[],
  field: "notices" | "assignments",
  today: string,
): MergedSection {
  for (const scope of SCOPE_PRECEDENCE) {
    const scopeRows = rows
      .filter((r) => r.scope === scope)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const active: unknown[] = [];
    for (const r of scopeRows) {
      const items = nonEmptyArray(r[field]);
      if (!items) {
        continue;
      }
      for (const it of items) {
        const ok =
          field === "notices" ? isNoticeActive(it, r.date, today) : isAssignmentActive(it, today);
        if (ok) {
          active.push(it);
        }
      }
    }
    if (active.length > 0) {
      if (field === "assignments") {
        active.sort((a, b) => {
          const da = (a as { deadline: string }).deadline;
          const db = (b as { deadline: string }).deadline;
          return da < db ? -1 : da > db ? 1 : 0;
        });
      }
      return { items: active, source: scope };
    }
  }
  return { items: [], source: null };
}

/**
 * 遡及窓の行 (今日を含む過去 N 日) から実効日次データを組む。schedules / quietHours は当日行のみで
 * (mergeDailySections と同規約)、notices / assignments は窓内の活性項目を採用する (#243 表示日数)。
 * **純関数** — DB 非依存でテスト可能。
 */
export function mergeEffectiveWithWindow(
  date: string,
  windowRows: DailyWindowRow[],
  quietHoursFallback: unknown[] | null = null,
): EffectiveDailyData {
  const todayRows = windowRows.filter((r) => r.date === date);
  const single = mergeDailySections(date, todayRows, quietHoursFallback);
  return {
    ...single,
    notices: mergeWindowedSection(windowRows, "notices", date),
    assignments: mergeWindowedSection(windowRows, "assignments", date),
  };
}

/**
 * クラスの階層 (所属学年・所属学科)。学科は **学年経由 (`grades.department_id`) を優先しつつ、学年なし
 * クラス (= 「その他」/grade_id NULL) では `classes.department_id` を直接採る** (段A-2 + 「その他」対応)。
 * `gradeId` / `departmentId` は未割当のとき null (学年未割当クラス / クラスモード校の学年は学科なし /
 * 学校直下の「その他」)。
 */
type ClassHierarchy = { gradeId: string | null; departmentId: string | null };

/**
 * クラスの所属学年・所属学科を 1 クエリ (grades への left join) で解決する。不可視/不在なら null。
 *
 * 通常クラスは学科を `grade_id → grades.department_id` 経由で持つが、「その他」(grade_id NULL の設置場所)
 * はその経路を辿れないため `classes.department_id` を直接持つ (schema `classes.ts` 参照)。学科は
 * **`grades.department_id` を優先し、無ければ `classes.department_id` に coalesce** する ─ これで「その他」の
 * サイネージ階層フォールバックが class → department → school (grade 段はスキップ) になる。通常クラスでは
 * `classes.department_id` は通常 NULL なので挙動不変。
 */
async function resolveClassHierarchy(
  tx: TenantTx,
  classId: string,
): Promise<ClassHierarchy | null> {
  const [row] = await tx
    .select({
      gradeId: classes.gradeId,
      departmentId: sql<string | null>`coalesce(${grades.departmentId}, ${classes.departmentId})`,
    })
    .from(classes)
    .leftJoin(grades, eq(classes.gradeId, grades.id))
    .where(eq(classes.id, classId))
    .limit(1);
  return row ?? null;
}

/**
 * クラス視点で読むべき daily_data 行を選ぶ OR 句 (精度 class > grade > department > school)。
 * 学年未割当 (grade_id NULL) は学年スコープを、学科未解決 (department_id NULL) は学科スコープを引かない。
 */
function scopeRowsForClass(classId: string, cls: ClassHierarchy) {
  return or(
    and(eq(dailyData.scope, "class"), eq(dailyData.classId, classId)),
    cls.gradeId ? and(eq(dailyData.scope, "grade"), eq(dailyData.gradeId, cls.gradeId)) : undefined,
    cls.departmentId
      ? and(eq(dailyData.scope, "department"), eq(dailyData.departmentId, cls.departmentId))
      : undefined,
    eq(dailyData.scope, "school"),
  );
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
  const cls = await resolveClassHierarchy(tx, classId);
  if (!cls) {
    return null;
  }

  // 連絡(表示日数)・提出物(期限+猶予)を多日表示するため、当日だけでなく過去 EFFECTIVE_LOOKBACK_DAYS 日分の
  // 行を 1 クエリで読む (schedules/quietHours は当日行のみ使用 = mergeEffectiveWithWindow が振り分け)。
  // **固定表示 (pinned・F-C §5.4)**: pinned な連絡は自然消滅しないため、遡及窓の**外**でも
  // `notices @> '[{"pinned":true}]'` (JSONB 包含) の行を OR で拾う。クラスの daily_data は高々
  // 1 行/日×scope なので全期間スキャンでも実害なし (性能問題が出たら partial GIN index を後続 migration で・
  // 設計書 §10。v1 では張らない)。同じ拡張を学校管理ハブの窓 read (`packages/db` getDailyWindowRows) にも
  // 同一 PR で適用している (§11-7)。RLS により自校に限定される (ルール2、手書き WHERE school_id 非依存)。
  const windowStart = addDays(date, -(EFFECTIVE_LOOKBACK_DAYS - 1));
  const rows = await tx
    .select({
      scope: dailyData.scope,
      date: dailyData.date,
      schedules: dailyData.schedules,
      notices: dailyData.notices,
      assignments: dailyData.assignments,
      quietHours: dailyData.quietHours,
    })
    .from(dailyData)
    .where(
      and(
        lte(dailyData.date, date),
        or(
          gte(dailyData.date, windowStart),
          sql`${dailyData.notices} @> '[{"pinned":true}]'::jsonb`,
        ),
        scopeRowsForClass(classId, cls),
      ),
    );

  // クラスの永続既定 (school_configs scope=class kind='quiet_hours')。当日 daily_data に quiet_hours の
  // override が無いときのフォールバック (#191、優先順は override > 既定)。同じ RLS コンテキストで自校限定。
  // 値は `{ ranges: [...] }` オブジェクトなので readQuietRanges で配列形に揃える (値形ブリッジ)。
  const quietHoursConfig = await getClassConfigValue(tx, classId, "quiet_hours");
  const quietHoursFallback = readQuietRanges(quietHoursConfig);

  return mergeEffectiveWithWindow(date, rows, quietHoursFallback);
}

/** 1 日分の実効「予定」セクション。`getEffectiveScheduleDays` が日付配列ぶん返す。 */
export type ScheduleDay = { date: string; schedule: MergedSection };

/**
 * v1 サイネージの「予定」3 列グリッド (今後 3 平日) 用に、**複数日付ぶんの予定セクションを 1 クエリで**
 * 取得し、日付ごとに class > grade > school で精度優先マージする (#48-E1 のマージ規約を schedules に
 * 限定して横展開)。連絡/課題/静粛時間は当日分のみで足りるため本関数は **schedules だけ**を読む
 * (`daily_data` の他カラムは引かない = 転送量最小)。
 *
 * **テナント分離 (ルール2)**: `getEffectiveDailyData` と同様、RLS コンテキスト設定済 tx 内で呼ぶこと。
 * `daily_data` の SELECT は `app.current_school_id` で自校に限定される (手書き `WHERE school_id` 非依存)。
 *
 * @param dates 取得する暦日 (YYYY-MM-DD) の配列。空なら空配列を返す。各日付に行が無ければ空セクション。
 */
export async function getEffectiveScheduleDays(
  tx: TenantTx,
  classId: string,
  dates: string[],
): Promise<ScheduleDay[]> {
  if (dates.length === 0) {
    return [];
  }
  const cls = await resolveClassHierarchy(tx, classId);
  if (!cls) {
    // クラス不可視/不在: 全日空 (盤面はプレースホルダー行で 5 行を保つ)。
    return dates.map((date) => ({ date, schedule: { items: [], source: null } }));
  }

  const rows = await tx
    .select({ scope: dailyData.scope, date: dailyData.date, schedules: dailyData.schedules })
    .from(dailyData)
    .where(and(inArray(dailyData.date, dates), scopeRowsForClass(classId, cls)));

  return dates.map((date) => ({
    date,
    schedule: pickScheduleForDate(rows.filter((r) => r.date === date)),
  }));
}

/** 1 日分の scope 別行から schedules を精度優先 (class > grade > department > school) で 1 つ選ぶ。 */
function pickScheduleForDate(rows: Array<{ scope: string; schedules: unknown }>): MergedSection {
  for (const scope of SCOPE_PRECEDENCE) {
    const row = rows.find((r) => r.scope === scope);
    const items = row ? nonEmptyArray(row.schedules) : null;
    if (items) {
      return { items, source: scope };
    }
  }
  return { items: [], source: null };
}
