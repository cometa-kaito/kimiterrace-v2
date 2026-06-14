import { type SchoolEventSummary, type TenantTx, events, schools } from "@kimiterrace/db";
import { type SQL, and, eq, gte, lt, sql } from "drizzle-orm";
import type { ListParams } from "@/app/_components/datalist/list-params";

/**
 * UIUX-03: 全校ダッシュボード (`/ops/dashboard`) の **日付範囲対応** 集計層。
 *
 * ## 置き場所 (並行レーン回避)
 * `packages/db` (chokepoint) を編集せず `apps/web/lib` に置く (`school-list.ts` /
 * `effect-comment-stats.ts` と同じ規律)。集計内容は packages/db `getEventStatsBySchool`
 * (queries/event-stats.ts) と同一だが、`sinceDays` (DB now() 基準の遡及日数固定) ではなく
 * **明示的な期間境界 (since / untilExclusive)** を受け取る。テーブルは barrel から import し、
 * 行型は schema 由来の `SchoolEventSummary` を再利用する (ルール3、手書き再定義しない)。
 *
 * ## JST 境界 (#341 の罠回避)
 * 期間境界は呼び出し側が `dateRangeBounds` (list-params.ts) で **明示オフセット (+09:00)** から
 * 組んだ絶対時刻 (Date) を渡す。Date は bind 時に timestamptz の絶対時刻として比較されるため、
 * DB セッション TZ に依存しない。#341 (monthly-report.ts) で実検出された
 * 「セッション TZ で interval 加算すると JST 境界がずれる」罠は、SQL 側で日付演算を一切しない
 * ことで踏まない。
 *
 * ## テナント分離 (CLAUDE.md ルール2)
 * `school_id` / role の WHERE は**書かない** — events / schools の RLS に委譲する。system_admin
 * コンテキスト (`withSession`) では `system_admin_full_access` が全校行に発火し横断集計になる。
 *
 * ## PII (ルール4)
 * 集計は件数のみで `events.payload` の匿名 clientId 等は読まない (event-stats.ts と同方針)。
 */

type Selectable = Pick<TenantTx, "select">;

/** 既定の集計窓 (未指定時の「直近 30 日」)。従来の getEventStatsBySchool の既定と揃える。 */
export const DEFAULT_SINCE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** epochMs を JST 暦日の YYYY-MM-DD にする (en-CA ロケール = ISO 形式、サーバー TZ 非依存)。 */
function jstDateString(epochMs: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(epochMs));
}

/**
 * from/to 未指定時の既定範囲 = **直近 30 JST 暦日** (本日含む、from = 本日-29日)。
 *
 * 従来 (`getEventStatsBySchool` の `now() - interval '30 days'`) はタイムスタンプのローリング窓
 * だったのに対し、こちらは日付ピッカーと同じ **JST 暦日境界** に丸める (from の 0:00 JST 〜
 * 本日末尾)。見出しに表示する期間と集計窓が文字どおり一致することを優先する。JST は夏時間が
 * 無いため epochMs の単純減算で暦日が壊れることはない。
 */
export function defaultDashboardRange(now: Date = new Date()): { from: string; to: string } {
  return {
    from: jstDateString(now.getTime() - (DEFAULT_SINCE_DAYS - 1) * DAY_MS),
    to: jstDateString(now.getTime()),
  };
}

/**
 * **全校横断**で学校別の行動サマリーを期間指定付きで集計する (system_admin 専用、RLS 委譲)。
 *
 * packages/db `getEventStatsBySchool` と同じ射影 (view/tap/ask 件数 + 反応数) ・同じ INNER JOIN
 * (期間内に event のあった学校のみが行として現れる)。並びは反応数降順 → 学校名 → schoolId で
 * 決定的だが、表示側 (`sortSchoolSummaries`) がメモリ内で並べ替えるため既定順序の意味は薄い。
 *
 * @param range.since 期間開始 (含む)。null = 開始境界なし。
 * @param range.untilExclusive 期間終了 (排他、to 翌日 0:00 JST)。null = 終了境界なし。
 */
export async function getEventStatsBySchoolRange(
  db: Selectable,
  range: { since: Date | null; untilExclusive: Date | null },
): Promise<SchoolEventSummary[]> {
  const conditions: SQL[] = [];
  if (range.since) {
    conditions.push(gte(events.occurredAt, range.since));
  }
  if (range.untilExclusive) {
    conditions.push(lt(events.occurredAt, range.untilExclusive));
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const views = sql<number>`count(*) filter (where ${events.type} = 'view')`.mapWith(Number);
  const taps = sql<number>`count(*) filter (where ${events.type} = 'tap')`.mapWith(Number);
  const asks = sql<number>`count(*) filter (where ${events.type} = 'ask')`.mapWith(Number);
  // 反応数 = view + tap (ask は別指標として totals.ask にのみ計上、event-stats.ts と同方針)。
  const reactions = sql<number>`count(*) filter (where ${events.type} in ('view', 'tap'))`.mapWith(
    Number,
  );

  const rows = await db
    .select({
      schoolId: schools.id,
      schoolName: schools.name,
      prefecture: schools.prefecture,
      views,
      taps,
      asks,
      reactions,
    })
    .from(events)
    .innerJoin(schools, eq(events.schoolId, schools.id))
    .where(where)
    .groupBy(schools.id, schools.name, schools.prefecture)
    // 反応数同数でも順序を決定的にするため schoolName → schoolId を二次/三次キーにする。
    .orderBy(
      sql`count(*) filter (where ${events.type} in ('view', 'tap')) desc`,
      schools.name,
      schools.id,
    );

  return rows.map((r) => ({
    schoolId: r.schoolId,
    schoolName: r.schoolName,
    prefecture: r.prefecture,
    totals: { view: r.views, tap: r.taps, ask: r.asks },
    reactions: r.reactions,
  }));
}

/** 列ソートの allowlist。DataTable の列 key / parseListParams の sortKeys と 1 箇所で対応させる。 */
export const DASHBOARD_SORT_KEYS = [
  "schoolName",
  "prefecture",
  "view",
  "tap",
  "ask",
  "reactions",
] as const;

/** ソートキー → 比較値。数値列は totals から、文字列列はそのまま取り出す。 */
function sortValue(s: SchoolEventSummary, key: string): string | number {
  switch (key) {
    case "schoolName":
      return s.schoolName;
    case "prefecture":
      return s.prefecture;
    case "view":
      return s.totals.view;
    case "tap":
      return s.totals.tap;
    case "ask":
      return s.totals.ask;
    default:
      return s.reactions;
  }
}

/**
 * 学校別サマリーを **メモリ内**で並べ替える (非破壊)。行数は学校数程度 (数十〜数百) なので
 * SQL の ORDER BY に持ち込まずアプリ側で完結させる (totals がネストしており SQL ソートに
 * マップするより単純)。同値は dir に依らず 学校名 → schoolId 昇順で決定的にする。
 */
export function sortSchoolSummaries(
  rows: readonly SchoolEventSummary[],
  params: Pick<ListParams, "sort" | "dir">,
): SchoolEventSummary[] {
  const sign = params.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = sortValue(a, params.sort);
    const vb = sortValue(b, params.sort);
    const primary =
      typeof va === "number" && typeof vb === "number"
        ? va - vb
        : String(va).localeCompare(String(vb), "ja");
    if (primary !== 0) {
      return primary * sign;
    }
    return a.schoolName.localeCompare(b.schoolName, "ja") || a.schoolId.localeCompare(b.schoolId);
  });
}
