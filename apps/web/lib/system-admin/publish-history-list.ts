import { type TenantTx, contentVersions, contents, publishes, schools } from "@kimiterrace/db";
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
  isNotNull,
  isNull,
  lt,
} from "drizzle-orm";
import {
  type ListParams,
  dateRangeBounds,
  escapeLike,
  pageWindow,
} from "@/app/_components/datalist/list-params";

/**
 * UIUX-03: コンテンツ公開履歴ブラウザ (`/ops/publishes`) の SELECT 層。
 * `audit-log-list.ts` / `ai-chat-list.ts` と同構造 (共通 DataList 基盤)。
 *
 * ## 置き場所 (並行レーン回避)
 * `packages/db` (chokepoint) を編集せず `apps/web/lib` に置く。テーブルは barrel から import し、
 * 行型は schema 由来 (`InferSelectModel`、ルール3)。
 *
 * ## テナント分離 (ルール2 / ADR-019)
 * publishes / contents / content_versions はすべて school_id を持つテナントテーブルで、可視範囲は
 * 呼出側 (`withSession`) が張る RLS context が決める (system_admin=全行)。本層の WHERE は
 * **検索条件のみ** — school フィルタは「絞り込み」であってテナント境界ではない。
 *
 * ## PII (ルール4)
 * snapshot / diff_summary は教員入力由来の自由テキストを含みうる。本層は生のまま返し、
 * **表示側 (ページ) が formatMaskedJson / truncateText を必ず通す**。embedding 列は
 * 射影に含めない (表示用途がなく、持ち出し面を増やさない)。
 */

/** SELECT だけできれば良い。 */
type Selectable = Pick<TenantTx, "select">;

type PublishRow = InferSelectModel<typeof publishes>;
type ContentRow = InferSelectModel<typeof contents>;
type ContentVersionRow = InferSelectModel<typeof contentVersions>;

/** ソート可能列の allowlist。`parseListParams` の sortKeys と ORDER BY を 1 箇所で対応させる。 */
export const PUBLISH_SORT_COLUMNS = {
  publishedAt: publishes.publishedAt,
  schoolName: schools.name,
  title: contents.title,
} as const;

export const PUBLISH_SORT_KEYS = Object.keys(PUBLISH_SORT_COLUMNS) as readonly string[];

/** 公開状態フィルタの値域 (active=公開中 / ended=公開終了)。 */
export const PUBLISH_STATUS_VALUES = ["active", "ended"] as const;

export type PublishStatusFilter = (typeof PUBLISH_STATUS_VALUES)[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** school フィルタの形式検証 (uuid 形式のみ通す)。テナント境界ではない (境界は RLS)。 */
export function parseSchoolFilter(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const lower = value.toLowerCase();
  return UUID_RE.test(lower) ? lower : null;
}

/** 公開状態フィルタの検証 (範囲外は黙って無視、URL は外部入力)。 */
export function parsePublishStatusFilter(value: string | undefined): PublishStatusFilter | null {
  if (value !== undefined && (PUBLISH_STATUS_VALUES as readonly string[]).includes(value)) {
    return value as PublishStatusFilter;
  }
  return null;
}

/** 一覧 1 行。schema 由来の射影 + join した校名・タイトル・版番号。 */
export type PublishHistoryEntry = Pick<
  PublishRow,
  "id" | "schoolId" | "contentId" | "versionId" | "publishedAt" | "unpublishedAt"
> & {
  schoolName: string;
  title: string;
  /**
   * content_versions.version。version_id は NOT NULL + FK (onDelete: restrict) のため通常必ず
   * 引けるが、leftJoin で型を null 許容にし、引けない場合は呼出側が versionId 表示で代替する。
   */
  version: number | null;
};

/** 一覧 1 ページ分 + 総件数。 */
export type PublishHistoryPage = { rows: PublishHistoryEntry[]; total: number };

/**
 * 公開履歴を検索 (タイトル部分一致)・学校/公開状態フィルタ・公開日範囲・列ソート・ページングで
 * 取得する。contents / schools は NOT NULL FK の PK 結合なので innerJoin (件数は変わらない)。
 * content_versions は版番号表示のためだけの leftJoin。同値ソートでも順序が安定するよう id を
 * 最終タイブレークに付ける。
 */
export async function listPublishHistoryPage(
  db: Selectable,
  params: ListParams,
): Promise<PublishHistoryPage> {
  const conditions: SQL[] = [];
  if (params.q) {
    // q はタイトルのみ対象 (snapshot 本文への全文検索は自由テキスト露出面を増やすため提供しない)。
    conditions.push(ilike(contents.title, `%${escapeLike(params.q)}%`));
  }
  const school = parseSchoolFilter(params.filters.school);
  if (school) {
    conditions.push(eq(publishes.schoolId, school));
  }
  const status = parsePublishStatusFilter(params.filters.status);
  if (status === "active") {
    conditions.push(isNull(publishes.unpublishedAt));
  } else if (status === "ended") {
    conditions.push(isNotNull(publishes.unpublishedAt));
  }
  const { since, untilExclusive } = dateRangeBounds(params);
  if (since) {
    conditions.push(gte(publishes.publishedAt, since));
  }
  if (untilExclusive) {
    conditions.push(lt(publishes.publishedAt, untilExclusive));
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const sortColumn =
    PUBLISH_SORT_COLUMNS[params.sort as keyof typeof PUBLISH_SORT_COLUMNS] ?? publishes.publishedAt;
  const orderBy =
    params.dir === "asc"
      ? [asc(sortColumn), asc(publishes.id)]
      : [desc(sortColumn), asc(publishes.id)];
  const { limit, offset } = pageWindow(params);

  const [rows, totals] = await Promise.all([
    db
      .select({
        id: publishes.id,
        schoolId: publishes.schoolId,
        schoolName: schools.name,
        contentId: publishes.contentId,
        title: contents.title,
        versionId: publishes.versionId,
        version: contentVersions.version,
        publishedAt: publishes.publishedAt,
        unpublishedAt: publishes.unpublishedAt,
      })
      .from(publishes)
      .innerJoin(contents, eq(publishes.contentId, contents.id))
      .innerJoin(schools, eq(publishes.schoolId, schools.id))
      .leftJoin(contentVersions, eq(publishes.versionId, contentVersions.id))
      .where(where)
      .orderBy(...orderBy)
      .limit(limit)
      .offset(offset),
    // WHERE が contents.title (q) を参照しうるため count にも contents を join する
    // (PK 結合の innerJoin は件数を変えない)。schools / content_versions は WHERE に出ないので不要。
    db
      .select({ value: count() })
      .from(publishes)
      .innerJoin(contents, eq(publishes.contentId, contents.id))
      .where(where),
  ]);

  return { rows, total: totals[0]?.value ?? 0 };
}

/** 版履歴の表示上限 (更新が異常多発したコンテンツでの描画爆発防止。超過は件数表示)。 */
export const VERSION_HISTORY_LIMIT = 200;

/** 版 1 行。**embedding は射影に含めない** (モジュール doc 参照)。 */
export type ContentVersionEntry = Pick<
  ContentVersionRow,
  "id" | "version" | "createdAt" | "diffSummary" | "snapshot"
>;

/** 1 コンテンツの版履歴 (コンテンツメタ + version 降順の版一覧)。 */
export type ContentVersionHistory = {
  content: Pick<ContentRow, "id" | "schoolId" | "title" | "status"> & { schoolName: string };
  versions: ContentVersionEntry[];
  totalVersions: number;
};

/**
 * 1 コンテンツの版履歴を取得する (無ければ null)。可視範囲は RLS。
 * (content_id, version) UNIQUE のため version 降順だけで順序は一意に定まる。
 */
export async function getContentVersionHistory(
  db: Selectable,
  contentId: string,
): Promise<ContentVersionHistory | null> {
  if (!UUID_RE.test(contentId.toLowerCase())) {
    return null;
  }
  const contentRows = await db
    .select({
      id: contents.id,
      schoolId: contents.schoolId,
      title: contents.title,
      status: contents.status,
      schoolName: schools.name,
    })
    .from(contents)
    .innerJoin(schools, eq(contents.schoolId, schools.id))
    .where(eq(contents.id, contentId))
    .limit(1);
  const content = contentRows[0];
  if (!content) {
    return null;
  }
  const [versions, totals] = await Promise.all([
    db
      .select({
        id: contentVersions.id,
        version: contentVersions.version,
        createdAt: contentVersions.createdAt,
        diffSummary: contentVersions.diffSummary,
        snapshot: contentVersions.snapshot,
      })
      .from(contentVersions)
      .where(eq(contentVersions.contentId, contentId))
      .orderBy(desc(contentVersions.version))
      .limit(VERSION_HISTORY_LIMIT),
    db
      .select({ value: count() })
      .from(contentVersions)
      .where(eq(contentVersions.contentId, contentId)),
  ]);
  return { content, versions, totalVersions: totals[0]?.value ?? 0 };
}
