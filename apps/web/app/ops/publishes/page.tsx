import { listSchools } from "@kimiterrace/db";
import { tokens } from "@kimiterrace/ui";
import Link from "next/link";
import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { truncateText } from "@/lib/system-admin/mask";
import {
  PUBLISH_SORT_KEYS,
  PUBLISH_STATUS_VALUES,
  type PublishStatusFilter,
  listPublishHistoryPage,
} from "@/lib/system-admin/publish-history-list";
import { SYSTEM_ADMIN_ROLES } from "@/lib/system-admin/roles";
import { DataListControls } from "../../_components/datalist/DataListControls";
import { DataTable } from "../../_components/datalist/DataTable";
import { PaginationNav } from "../../_components/datalist/PaginationNav";
import { type RawSearchParams, parseListParams } from "../../_components/datalist/list-params";

const { color, fontSize, space } = tokens;

const BASE_PATH = "/ops/publishes";

/** 公開状態フィルタの表示ラベル。値域を網羅 (型でズレ検出、ルール3)。 */
const STATUS_LABEL: Record<PublishStatusFilter, string> = {
  active: "公開中",
  ended: "公開終了",
};

/**
 * UIUX-03: コンテンツ公開履歴一覧 (`/ops/publishes`)。**Server Component**。
 *
 * publishes (どの版をいつ公開/公開終了したか) を contents (タイトル) / schools (校名) /
 * content_versions (版番号) に join し、共通 DataList 基盤 (検索 / 学校・公開状態フィルタ /
 * 公開日範囲 / 列ソート / ページング) で一覧する。データ取得は `listPublishHistoryPage`
 * (apps/web/lib) がサーバーサイドで絞り込む。
 *
 * **認可**: `requireRole(SYSTEM_ADMIN_ROLES)` (system_admin のみ)。可視範囲は RLS
 * (system_admin_full_access) に委譲し、クエリ層は role / school_id の WHERE を書かない
 * (ルール2 多層防御。学校セレクトは絞り込みであってテナント境界ではない)。
 *
 * **閲覧監査を記録しない理由 (audit / ai-chat 一覧との差)**: 本一覧が出すのは公開イベントの
 * 事実 (日時・学校・タイトル・版番号・状態) のみで、snapshot / diff_summary 等の自由テキスト
 * 本体は表示しない。タイトルも切り詰め表示に留める。PII 露出面を持つのは版履歴ページ
 * (`[contentId]/page.tsx`) 側で、閲覧監査 (`content_versions_view_access`) はそちらで記録する。
 * 監査 INSERT を伴わないため `force-dynamic` も不要 (通常の SSR キャッシュ規律のまま)。
 */
export default async function SystemPublishHistoryPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  await requireRole(SYSTEM_ADMIN_ROLES);
  const params = parseListParams(await searchParams, {
    sortKeys: PUBLISH_SORT_KEYS,
    defaultSort: "publishedAt",
    defaultDir: "desc",
    filterKeys: ["school", "status"],
  });

  const { page, schoolOptions } = await withSession(async (tx) => {
    const [pageResult, allSchools] = await Promise.all([
      listPublishHistoryPage(tx, params),
      listSchools(tx),
    ]);
    return { page: pageResult, schoolOptions: allSchools };
  });
  const { rows, total } = page;

  const hasCondition =
    params.q !== "" ||
    params.from != null ||
    params.to != null ||
    Object.keys(params.filters).length > 0;

  return (
    <section>
      <header style={headerStyle}>
        <h1 style={titleStyle}>公開履歴</h1>
        <span style={countStyle}>{total.toLocaleString("ja-JP")} 件</span>
      </header>
      <p style={noteStyle}>
        コンテンツの公開イベント履歴 (どの版をいつ公開し、いつ公開終了したか)。タイトルから各
        コンテンツの版履歴 (差分・snapshot 要約) を辿れます。
      </p>

      <DataListControls
        basePath={BASE_PATH}
        params={params}
        searchPlaceholder="コンテンツタイトル"
        selects={[
          {
            name: "school",
            label: "学校",
            options: schoolOptions.map((s) => ({
              value: s.id,
              label: `${s.name}（${s.prefecture}）`,
            })),
          },
          {
            name: "status",
            label: "公開状態",
            // 値域を網羅 (STATUS_LABEL が Record で担保)。
            options: PUBLISH_STATUS_VALUES.map((v) => ({ value: v, label: STATUS_LABEL[v] })),
          },
        ]}
        dateRange
        dateRangeLabel="公開日"
      />

      <DataTable
        basePath={BASE_PATH}
        params={params}
        empty={hasCondition ? "条件に合う公開履歴がありません。" : "まだ公開履歴がありません。"}
        columns={[
          { key: "publishedAt", label: "公開日時", sortable: true },
          { key: "schoolName", label: "学校", sortable: true },
          { key: "title", label: "コンテンツタイトル", sortable: true },
          { key: "version", label: "版番号", align: "right" },
          { key: "status", label: "公開状態" },
          { key: "actions", label: "" },
        ]}
        rows={rows.map((r) => ({
          key: r.id,
          cells: [
            <time key="publishedAt" dateTime={r.publishedAt.toISOString()} style={dateStyle}>
              {formatJstDateTime(r.publishedAt)}
            </time>,
            r.schoolName,
            // タイトルは教員入力の自由テキスト — 全文露出を避け切り詰め表示 (mask.ts 規律)。
            <span key="title" style={titleCellStyle}>
              {truncateText(r.title)}
            </span>,
            // version_id は NOT NULL FK (restrict) のため通常必ず版番号が引ける。
            // 万一 join が外れた場合は version_id 短縮表示で痕跡を残す (リンク先で全版を確認可能)。
            r.version != null ? (
              `v${r.version}`
            ) : (
              <code key="version" title={r.versionId} style={monoStyle}>
                {shortHex(r.versionId)}
              </code>
            ),
            r.unpublishedAt == null ? (
              <strong key="status" style={activeStyle}>
                公開中
              </strong>
            ) : (
              <span key="status" style={endedStyle}>
                公開終了
                <time
                  dateTime={r.unpublishedAt.toISOString()}
                  style={{ ...dateStyle, display: "block", fontSize: fontSize.xs }}
                >
                  {formatJstDateTime(r.unpublishedAt)}
                </time>
              </span>
            ),
            <Link key="versions" href={`${BASE_PATH}/${r.contentId}`} style={detailLinkStyle}>
              版履歴を見る
            </Link>,
          ],
        }))}
      />

      <PaginationNav basePath={BASE_PATH} params={params} total={total} />
    </section>
  );
}

/** uuid の先頭 8 桁 (フル値は title 属性で渡す)。 */
function shortHex(value: string): string {
  return value.slice(0, 8);
}

/** JST の YYYY/MM/DD HH:mm 表示 (サーバー描画、ロケール非依存)。 */
function formatJstDateTime(value: Date): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(value);
}

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  marginBottom: space.xs,
};
const titleStyle: React.CSSProperties = { fontSize: "1.3rem", fontWeight: 700 };
const countStyle: React.CSSProperties = { fontSize: fontSize.sm, color: color.muted };
const noteStyle: React.CSSProperties = {
  fontSize: fontSize.sm,
  color: color.muted,
  margin: `0 0 ${space.md}`,
};
const dateStyle: React.CSSProperties = { color: color.muted, whiteSpace: "nowrap" };
const titleCellStyle: React.CSSProperties = { overflowWrap: "anywhere" };
const monoFamily = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const monoStyle: React.CSSProperties = {
  fontFamily: monoFamily,
  fontSize: fontSize.xs,
  whiteSpace: "nowrap",
};
const activeStyle: React.CSSProperties = { whiteSpace: "nowrap" };
const endedStyle: React.CSSProperties = { color: color.muted, whiteSpace: "nowrap" };
const detailLinkStyle: React.CSSProperties = { color: color.primary, fontSize: fontSize.sm };
