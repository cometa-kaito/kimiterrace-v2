import { type TenantTx, contents, events, eventType, schools } from "@kimiterrace/db";
import {
  type InferSelectModel,
  type SQL,
  and,
  asc,
  count,
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
} from "@/app/_components/datalist/list-params";

/**
 * UIUX-03: events 生ログビューア (`/ops/events`) のページング/検索/集計 SELECT 層。
 *
 * ## 置き場所 (並行レーン回避)
 * `packages/db` (chokepoint) を編集せず `apps/web/lib` に置く (`school-list.ts` と同じ規律)。
 * テーブル/enum は barrel から import し、行型は schema 由来 (`InferSelectModel`、ルール3)。
 *
 * ## テナント分離 (ルール2)
 * `school_id` / role の WHERE を**テナント境界としては**書かない — 呼び出し側 (`withSession`) が
 * 張る RLS コンテキストが可視範囲を決める (events には `system_admin_full_access` policy あり)。
 * `filters.school` による絞り込みは**検索条件** (system_admin が任意校に絞る UI 機能) であって
 * 境界ではない (RLS が常に下層で守る)。
 *
 * ## q (フリーワード) の設計
 * payload は jsonb のため `payload::text` へキャストして ILIKE する (キー名・値の双方に当たる
 * 粗い firehose 検索。インデックスは効かないが、調査用途では日付/種別/学校で先に絞る前提)。
 * 加えて contents.title への ILIKE を OR で重ね、「このコンテンツ絡みのイベント」を題名でも
 * 引けるようにする。
 *
 * ## 集計サマリ (エクスポート代替)
 * 「エクスポートは集計のみ (生ログの一括持出不可)」方針の代替として、**現在のフィルタ条件と
 * 同一 WHERE** での type 別件数を groupBy 1 クエリで返す。raw export / CSV は提供しない。
 * count / groupBy クエリにも一覧と同じ JOIN を張る (q 条件が contents.title を参照するため)。
 * schools への innerJoin は school_id NOT NULL + FK で行を落とさず、contents への leftJoin は
 * PK 参照で行を増やさないため、件数は events 自体の件数と一致する。
 */

type Selectable = Pick<TenantTx, "select">;

/** イベント種別 (schema 由来の単一ソース、ルール3)。 */
export type EventType = (typeof eventType.enumValues)[number];

/** イベント種別の全値 (enum 定義順)。フィルタ options / 集計チップの描画順に使う。 */
export const EVENT_TYPES: readonly EventType[] = eventType.enumValues;

function isEventType(value: string): value is EventType {
  const all: readonly string[] = EVENT_TYPES;
  return all.includes(value);
}

/** `filters.type` を enum 値として検証する。非該当はフィルタなし (null)。 */
export function parseEventTypeFilter(value: string | undefined): EventType | null {
  return value !== undefined && isEventType(value) ? value : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * `filters.school` を uuid として検証する。非該当はフィルタなし (null)。
 * これは「uuid 形式でない値を SQL に渡さない」ための形式検証であって**テナント境界ではない** —
 * 境界は RLS (`system_admin_full_access`) が DB レベルで守る (ルール2)。
 */
export function parseSchoolFilter(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const normalized = value.toLowerCase();
  return UUID_RE.test(normalized) ? normalized : null;
}

/** ソート可能列の allowlist。`parseListParams` の sortKeys と ORDER BY を 1 箇所で対応させる。 */
export const EVENT_SORT_COLUMNS = {
  occurredAt: events.occurredAt,
  type: events.type,
  schoolName: schools.name,
} as const;

export const EVENT_SORT_KEYS = Object.keys(EVENT_SORT_COLUMNS) as readonly string[];

/** 一覧 1 行分。id/発生時刻/種別/payload は schema 由来、校名/題名は JOIN 由来。 */
export type EventLogRow = Pick<
  InferSelectModel<typeof events>,
  "id" | "occurredAt" | "type" | "schoolId" | "payload"
> & {
  schoolName: string;
  contentTitle: string | null;
};

/** 現在のフィルタ条件での type 別件数 (enum 網羅を型で強制)。 */
export type EventTypeCounts = Record<EventType, number>;

/** 一覧 1 ページ分 + 総件数 + type 別集計サマリ。 */
export type EventLogPage = {
  rows: EventLogRow[];
  total: number;
  typeCounts: EventTypeCounts;
};

/**
 * events 生ログを 種別/学校/発生日時範囲/フリーワード (payload::text + contents.title) で絞り、
 * 列ソート・ページングで 1 ページ分取得する。同一 WHERE での type 別件数 (集計サマリ) も
 * groupBy 1 クエリで並列に返す。同値ソートでも順序が安定するよう id を最終タイブレークに付ける。
 */
export async function listEventLogPage(db: Selectable, params: ListParams): Promise<EventLogPage> {
  const conditions: SQL[] = [];

  const type = parseEventTypeFilter(params.filters.type);
  if (type) {
    conditions.push(eq(events.type, type));
  }

  // 検索条件としての学校絞り込み (テナント境界は RLS、上記 docblock 参照)。
  const school = parseSchoolFilter(params.filters.school);
  if (school) {
    conditions.push(eq(events.schoolId, school));
  }

  const { since, untilExclusive } = dateRangeBounds(params);
  if (since) {
    conditions.push(gte(events.occurredAt, since));
  }
  if (untilExclusive) {
    conditions.push(lt(events.occurredAt, untilExclusive));
  }

  if (params.q) {
    const pattern = `%${escapeLike(params.q)}%`;
    const match = or(sql`${events.payload}::text ilike ${pattern}`, ilike(contents.title, pattern));
    if (match) {
      conditions.push(match);
    }
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const sortColumn =
    EVENT_SORT_COLUMNS[params.sort as keyof typeof EVENT_SORT_COLUMNS] ?? events.occurredAt;
  const orderBy =
    params.dir === "asc" ? [asc(sortColumn), asc(events.id)] : [desc(sortColumn), asc(events.id)];
  const { limit, offset } = pageWindow(params);

  const [rows, totals, grouped] = await Promise.all([
    db
      .select({
        id: events.id,
        occurredAt: events.occurredAt,
        type: events.type,
        schoolId: events.schoolId,
        schoolName: schools.name,
        contentTitle: contents.title,
        payload: events.payload,
      })
      .from(events)
      .innerJoin(schools, eq(events.schoolId, schools.id))
      .leftJoin(contents, eq(events.contentId, contents.id))
      .where(where)
      .orderBy(...orderBy)
      .limit(limit)
      .offset(offset),
    db
      .select({ value: count() })
      .from(events)
      .innerJoin(schools, eq(events.schoolId, schools.id))
      .leftJoin(contents, eq(events.contentId, contents.id))
      .where(where),
    db
      .select({ type: events.type, value: count() })
      .from(events)
      .innerJoin(schools, eq(events.schoolId, schools.id))
      .leftJoin(contents, eq(events.contentId, contents.id))
      .where(where)
      .groupBy(events.type),
  ]);

  const typeCounts: EventTypeCounts = { view: 0, tap: 0, dwell: 0, ask: 0, presence: 0 };
  for (const g of grouped) {
    typeCounts[g.type] = g.value;
  }

  return { rows, total: totals[0]?.value ?? 0, typeCounts };
}
