import { type InferSelectModel, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { dailyData } from "../schema/daily-data.js";

/**
 * #48-K3: 学校管理ハブ「本日の掲示状態」用、サイネージ実表示に整合した daily_data 遡及窓 read。
 *
 * 学校管理ハブの状態表示 (公開中 / 本日 掲示なし) は **サイネージに実際に出ている中身があるか** を映す
 * 必要がある。サイネージ実表示 (`apps/web/lib/signage/effective-daily-data.ts getEffectiveDailyData`) は
 * notices / assignments を当日だけでなく過去 `EFFECTIVE_LOOKBACK_DAYS` 日ぶん遡って表示する
 * (連絡の表示日数 / 提出物の期限+猶予)。本関数はその窓と同じ範囲 (今日を含む過去 N 日) の daily_data 行を
 * **自校・全 scope まとめて 1 クエリ** で返し、活性判定 (どの行が今日も掲示中か) は呼び出し側 (apps/web の
 * `reduceTodayActiveScopes`) が `isNoticeActive` / `isAssignmentActive` で行う ─ 活性ロジックの単一ソースを
 * サイネージと共有し、本層は **窓の DB 読み取り (範囲 + RLS) のみ** を担う (per-class ではなく一覧用に N クラスを
 * 1 クエリで賄うのが従来の per-class `getEffectiveDailyData` との差)。
 *
 * **日付境界 (JST)**: 窓の上限 (今日) と下限は TZ 事故を避けるため **SQL 側で** `(now() AT TIME ZONE
 * 'Asia/Tokyo')::date` を基準に決める。各行に同じ式で算出した `today` (YYYY-MM-DD) を載せ、呼び出し側の
 * 活性判定が「行の日付 vs 今日」を JST 基準で行えるようにする (サーバ TZ に依存しない)。
 *
 * **テナント分離 (CLAUDE.md ルール2 / ADR-019)**: RLS コンテキスト設定済 (`withTenantContext` /
 * `withSession`) の tx 内で呼ぶこと。`daily_data` の `tenant_isolation` policy により自校行に限定される
 * (手書き `WHERE school_id` は書かない、DB レベルで強制)。
 */

/** 遡及窓の 1 行。jsonb 各セクションは `daily_data` スキーマから派生 (型の単一ソース = Drizzle、ルール3)。 */
export type DailyWindowRow = Pick<
  InferSelectModel<typeof dailyData>,
  | "scope"
  | "gradeId"
  | "departmentId"
  | "classId"
  | "date"
  | "schedules"
  | "notices"
  | "assignments"
> & {
  /** 算出基準日 (JST, YYYY-MM-DD)。全行同値。活性判定が「行日付 vs 今日」を JST で比べるために載せる。 */
  today: string;
};

/** 自校の SELECT のみ可能な最小インターフェース (RLS tx をそのまま渡せる)。 */
type Selectable = Pick<PostgresJsDatabase, "select">;

/**
 * 今日を含む過去 `lookbackDays` 日 ((今日 - lookbackDays, 今日] = N 日) の自校 daily_data を全 scope 返す。
 * 範囲・今日は SQL 側 JST で決める。活性 (今日も掲示中か) の判定は呼び出し側に委ねる。
 */
export async function getDailyWindowRows(
  db: Selectable,
  lookbackDays: number,
): Promise<DailyWindowRow[]> {
  return db
    .select({
      scope: dailyData.scope,
      gradeId: dailyData.gradeId,
      departmentId: dailyData.departmentId,
      classId: dailyData.classId,
      date: dailyData.date,
      today: sql<string>`(now() AT TIME ZONE 'Asia/Tokyo')::date::text`,
      schedules: dailyData.schedules,
      notices: dailyData.notices,
      assignments: dailyData.assignments,
    })
    .from(dailyData)
    .where(
      sql`${dailyData.date} > (now() AT TIME ZONE 'Asia/Tokyo')::date - ${lookbackDays}::int
        AND ${dailyData.date} <= (now() AT TIME ZONE 'Asia/Tokyo')::date`,
    );
}
