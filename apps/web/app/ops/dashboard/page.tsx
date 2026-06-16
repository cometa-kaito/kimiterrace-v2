import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import {
  AD_SORT_KEYS,
  ADVERTISER_SORT_KEYS,
  type AdEventSummary,
  type AdvertiserEventSummary,
  getEventStatsByAdRange,
  getEventStatsByAdvertiserRange,
  sortAdSummaries,
  sortAdvertiserSummaries,
} from "@/lib/system-admin/dashboard-axes";
import {
  DASHBOARD_SORT_KEYS,
  defaultDashboardRange,
  getEventStatsBySchoolRange,
  sortSchoolSummaries,
} from "@/lib/system-admin/dashboard-stats";
import { SYSTEM_ADMIN_ROLES } from "@/lib/system-admin/roles";
import { tokens } from "@kimiterrace/ui";
import Link from "next/link";
import { DataListControls } from "../../_components/datalist/DataListControls";
import { DataTable } from "../../_components/datalist/DataTable";
import {
  type ListParams,
  type RawSearchParams,
  dateRangeBounds,
  listQueryString,
  parseListParams,
} from "../../_components/datalist/list-params";

const { color, fontSize, space } = tokens;

const BASE_PATH = "/ops/dashboard";

/** 集計軸 (運営整理 §4 item2)。モニタ別は events にデバイス識別子が無く別 issue #916。 */
const AXES = [
  { key: "school", label: "学校別" },
  { key: "advertiser", label: "企業別" },
  { key: "ad", label: "枠別" },
] as const;
type Axis = (typeof AXES)[number]["key"];

/** 軸ごとの列ソート allowlist + 既定ソート。軸切替時は当該軸の既定ソートへ戻す。 */
const SORT_BY_AXIS: Record<Axis, { keys: readonly string[]; defaultSort: string }> = {
  school: { keys: DASHBOARD_SORT_KEYS, defaultSort: "reactions" },
  advertiser: { keys: ADVERTISER_SORT_KEYS, defaultSort: "reactions" },
  ad: { keys: AD_SORT_KEYS, defaultSort: "reactions" },
};

/**
 * F08 (#44) / UIUX-03 / 運営整理 §4 item2: システム管理者の **全校横断ダッシュボード**
 * (`/ops/dashboard`)。**Server Component**。
 *
 * 運営 (system_admin) が全校の活動量を横断で把握する。**集計軸を切替可能** (`?axis=school|advertiser|ad`):
 *  - **学校別** (既定): 学校ごとの反応 (`getEventStatsBySchoolRange`)。
 *  - **企業別**: 広告主ごとの反応 (`getEventStatsByAdvertiserRange`、events.payload.adId → ads → advertisers)。
 *  - **枠別**: 広告 (配信割当) ごとの反応 (`getEventStatsByAdRange`)。
 *
 * **モニタ別**は events にデバイス識別子が無く現データモデルで実装不能のため別 issue (#916) に切り出した
 * (要 schema + ingestion + signage client)。
 *
 * UIUX-03: 期間は共通 DataList の日付範囲ピッカー (`?from=&to=`、未指定は直近 30 JST 暦日)。各軸テーブルは
 * DataTable 化して列ソート (`?sort=&dir=`、メモリ内) に対応。サマリーカードの合算は**全イベント基準** (軸非依存)
 * で学校別集計から畳む。
 *
 * **認可**: `/admin` レイアウトの `requireRole(ADMIN_ROLES)` に加え `requireRole(SYSTEM_ADMIN_ROLES)`
 * (system_admin のみ)。実データの越境は events / schools / ads / advertisers の RLS
 * (`system_admin_full_access`、ADR-019) が DB レベルで強制する (ルール2、多層防御)。集計は件数のみで
 * `events.payload` の匿名 clientId は読まない (ルール4)。
 *
 * **アクセシビリティ (NFR05 / WCAG 2.2 AA)**: 各軸サマリーは DataTable (`<table>` + `<th scope>` +
 * `aria-sort`) で提示し、数値は文字ラベル付きで色のみに依存しない。軸切替は `<nav>` + リンクで読み上げ可能。
 */
export default async function SystemDashboardPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  await requireRole(SYSTEM_ADMIN_ROLES);
  const rawParams = await searchParams;

  // 軸を先に解決し、その軸の sortKeys で残りを解析する (軸ごとに有効なソート列が異なるため)。
  const axisRaw = Array.isArray(rawParams.axis) ? rawParams.axis[0] : rawParams.axis;
  const axis: Axis = axisRaw === "advertiser" || axisRaw === "ad" ? axisRaw : "school";
  const sortCfg = SORT_BY_AXIS[axis];
  const params = parseListParams(rawParams, {
    sortKeys: sortCfg.keys,
    defaultSort: sortCfg.defaultSort,
    defaultDir: "desc",
    filterKeys: ["axis"],
  });

  // 期間解決: from/to が片方でも指定されていればそれを尊重。両方未指定なら直近 30 日 (JST 暦日)。
  const hasExplicitRange = params.from !== null || params.to !== null;
  const range = hasExplicitRange ? { from: params.from, to: params.to } : defaultDashboardRange();
  const { since, untilExclusive } = dateRangeBounds(range);

  // サマリーカードは全イベント基準 (軸非依存) のため学校別集計から畳む。学校軸ではテーブルにも再利用する。
  const schools = await withSession((tx) =>
    getEventStatsBySchoolRange(tx, { since, untilExclusive }),
  );
  const overall = schools.reduce(
    (acc, s) => ({
      view: acc.view + s.totals.view,
      tap: acc.tap + s.totals.tap,
      ask: acc.ask + s.totals.ask,
    }),
    { view: 0, tap: 0, ask: 0 },
  );

  const fromLabel = range.from ? toSlashDate(range.from) : "指定なし";
  const toLabel = range.to ? toSlashDate(range.to) : "現在";

  // 軸タブのリンク: 期間 (from/to) と検索を温存しつつ axis を切替え、ソートは当該軸の既定へ戻す。
  const axisHref = (a: Axis) =>
    `${BASE_PATH}${listQueryString(params, {
      filters: { axis: a },
      sort: SORT_BY_AXIS[a].defaultSort,
      dir: "desc",
      page: null,
    })}`;

  const table = await renderAxisTable(axis, params, schools, { since, untilExclusive });

  return (
    <section>
      <div style={headerStyle}>
        <h1 style={titleStyle}>全校ダッシュボード</h1>
        {/* ADR-020 公開透明性: 来場検知は PIR センサーでカメラ非使用。常時バッジで明示する。 */}
        <span
          style={cameraBadgeStyle}
          title="来場検知は人感(PIR)センサーのみ。カメラ・録画は使用しません。"
        >
          カメラ不使用
        </span>
      </div>
      <p style={subtitleStyle}>
        期間: {fromLabel}〜{toLabel}（未指定時は直近30日）・全校横断の反応
      </p>

      <DataListControls basePath={BASE_PATH} params={params} dateRange dateRangeLabel="期間" />

      <div style={cardsStyle}>
        <SummaryCard label="延べ表示数 (engagement)" value={overall.view} />
        <SummaryCard label="タップ (tap)" value={overall.tap} />
        <SummaryCard label="Q&A (ask)" value={overall.ask} />
      </div>

      <nav style={tabsStyle} aria-label="集計軸の切り替え">
        {AXES.map((a) => {
          const active = a.key === axis;
          return (
            <Link
              key={a.key}
              href={axisHref(a.key)}
              style={active ? tabActiveStyle : tabStyle}
              aria-current={active ? "page" : undefined}
              prefetch={false}
            >
              {a.label}
            </Link>
          );
        })}
      </nav>

      {table}

      <p style={footnoteStyle}>
        「延べ表示数
        (engagement)」は表示の延べ回数で、同じ内容を複数回・複数端末で表示した分も数えます。
        企業別・枠別は広告タップ等が紐づく広告 (events の adId)
        に限定した反応で、広告に紐づかない一般 Q&A は含みません。広告主向けの「到達数
        (reach)」は別指標 (重複排除済) です。
      </p>
    </section>
  );
}

/** 選択中の軸に応じてテーブルを構築する (集計クエリは軸選択時のみ実行)。 */
async function renderAxisTable(
  axis: Axis,
  params: ListParams,
  schools: Awaited<ReturnType<typeof getEventStatsBySchoolRange>>,
  range: { since: Date | null; untilExclusive: Date | null },
) {
  if (axis === "advertiser") {
    const rows = sortAdvertiserSummaries(
      await withSession((tx) => getEventStatsByAdvertiserRange(tx, range)),
      params,
    );
    return <AdvertiserTable params={params} rows={rows} />;
  }
  if (axis === "ad") {
    const rows = sortAdSummaries(
      await withSession((tx) => getEventStatsByAdRange(tx, range)),
      params,
    );
    return <AdTable params={params} rows={rows} />;
  }
  return <SchoolTable params={params} rows={sortSchoolSummaries(schools, params)} />;
}

function SchoolTable({
  params,
  rows,
}: {
  params: ListParams;
  rows: Awaited<ReturnType<typeof getEventStatsBySchoolRange>>;
}) {
  return (
    <>
      <h2 style={sectionTitleStyle}>学校別の反応</h2>
      <p style={tableNoteStyle}>既定は反応 (表示+タップ) が多い順。列見出しで並べ替えできます。</p>
      <DataTable
        basePath={BASE_PATH}
        params={params}
        empty="対象期間に活動のあった学校はまだありません。"
        columns={[
          { key: "schoolName", label: "学校", sortable: true },
          { key: "prefecture", label: "都道府県", sortable: true },
          { key: "view", label: "表示", sortable: true, align: "right" },
          { key: "tap", label: "タップ", sortable: true, align: "right" },
          { key: "ask", label: "Q&A", sortable: true, align: "right" },
          { key: "reactions", label: "反応計", sortable: true, align: "right" },
        ]}
        rows={rows.map((s) => ({
          key: s.schoolId,
          cells: [
            <strong key="name">{s.schoolName}</strong>,
            s.prefecture,
            s.totals.view.toLocaleString("ja-JP"),
            s.totals.tap.toLocaleString("ja-JP"),
            s.totals.ask.toLocaleString("ja-JP"),
            <strong key="reactions">{s.reactions.toLocaleString("ja-JP")}</strong>,
          ],
        }))}
      />
    </>
  );
}

function AdvertiserTable({ params, rows }: { params: ListParams; rows: AdvertiserEventSummary[] }) {
  return (
    <>
      <h2 style={sectionTitleStyle}>企業別の反応</h2>
      <p style={tableNoteStyle}>
        広告主ごとの反応 (その広告主の広告へのタップ・表示・Q&A)。既定は反応が多い順。
      </p>
      <DataTable
        basePath={BASE_PATH}
        params={params}
        empty="対象期間に広告主の広告への反応はまだありません。"
        columns={[
          { key: "companyName", label: "企業", sortable: true },
          { key: "view", label: "表示", sortable: true, align: "right" },
          { key: "tap", label: "タップ", sortable: true, align: "right" },
          { key: "ask", label: "Q&A", sortable: true, align: "right" },
          { key: "reactions", label: "反応計", sortable: true, align: "right" },
        ]}
        rows={rows.map((a) => ({
          key: a.advertiserId,
          cells: [
            <strong key="name">{a.companyName}</strong>,
            a.totals.view.toLocaleString("ja-JP"),
            a.totals.tap.toLocaleString("ja-JP"),
            a.totals.ask.toLocaleString("ja-JP"),
            <strong key="reactions">{a.reactions.toLocaleString("ja-JP")}</strong>,
          ],
        }))}
      />
    </>
  );
}

function AdTable({ params, rows }: { params: ListParams; rows: AdEventSummary[] }) {
  return (
    <>
      <h2 style={sectionTitleStyle}>枠 (広告) 別の反応</h2>
      <p style={tableNoteStyle}>
        広告 (配信割当) ごとの反応。枠名は広告のタイトル
        (caption)、未設定は「（無題の広告）」。既定は反応が多い順。
      </p>
      <DataTable
        basePath={BASE_PATH}
        params={params}
        empty="対象期間に広告への反応はまだありません。"
        columns={[
          { key: "caption", label: "枠 (広告)", sortable: true },
          { key: "companyName", label: "企業", sortable: true },
          { key: "view", label: "表示", sortable: true, align: "right" },
          { key: "tap", label: "タップ", sortable: true, align: "right" },
          { key: "ask", label: "Q&A", sortable: true, align: "right" },
          { key: "reactions", label: "反応計", sortable: true, align: "right" },
        ]}
        rows={rows.map((a) => ({
          key: a.adId,
          cells: [
            <strong key="caption">{a.caption ?? "（無題の広告）"}</strong>,
            a.companyName ?? "—",
            a.totals.view.toLocaleString("ja-JP"),
            a.totals.tap.toLocaleString("ja-JP"),
            a.totals.ask.toLocaleString("ja-JP"),
            <strong key="reactions">{a.reactions.toLocaleString("ja-JP")}</strong>,
          ],
        }))}
      />
    </>
  );
}

function SummaryCard({ label, value }: { label: string; value: number }) {
  return (
    <div style={cardStyle}>
      <span style={cardLabelStyle}>{label}</span>
      <span style={cardValueStyle}>{value.toLocaleString("ja-JP")}</span>
    </div>
  );
}

/** YYYY-MM-DD (検証済) → 表示用 YYYY/MM/DD。 */
function toSlashDate(isoDate: string): string {
  return isoDate.replaceAll("-", "/");
}

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
};
const titleStyle: React.CSSProperties = { fontSize: "1.3rem", fontWeight: 700, margin: 0 };
const cameraBadgeStyle: React.CSSProperties = {
  fontSize: "0.7rem",
  fontWeight: 600,
  color: color.successFg,
  background: color.successBg,
  border: `1px solid ${color.successBorder}`,
  borderRadius: "999px",
  padding: "0.15rem 0.6rem",
};
const subtitleStyle: React.CSSProperties = { color: color.muted, margin: "0.35rem 0 1.25rem" };
const cardsStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "1rem",
  marginBottom: "1.5rem",
};
const cardStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.35rem",
  minWidth: "9rem",
  padding: "1rem 1.25rem",
  border: `1px solid ${color.border}`,
  borderRadius: "10px",
};
const cardLabelStyle: React.CSSProperties = { fontSize: "0.8rem", color: color.muted };
const cardValueStyle: React.CSSProperties = {
  fontSize: "1.8rem",
  fontWeight: 700,
  color: color.ink,
};
const tabsStyle: React.CSSProperties = {
  display: "flex",
  gap: space.xs,
  borderBottom: `1px solid ${color.border}`,
  marginBottom: space.md,
  // 狭幅（モバイル）で軸タブが折返して下線が崩れるのを防ぐ。横スクロールに倒して 1 行を維持する
  // （2026-06-16 ユーザー指摘「タブのレイアウト崩れ」）。タブ自体は whiteSpace:nowrap（tabStyle）。
  overflowX: "auto",
};
const tabStyle: React.CSSProperties = {
  padding: "0.4rem 0.9rem",
  fontSize: fontSize.sm,
  color: color.muted,
  textDecoration: "none",
  borderBottom: "2px solid transparent",
  // 横スクロール時に 1 タブが折返さないよう固定（tabsStyle の overflowX:auto と対）。
  whiteSpace: "nowrap",
  flexShrink: 0,
};
const tabActiveStyle: React.CSSProperties = {
  ...tabStyle,
  color: color.ink,
  fontWeight: 700,
  borderBottom: `2px solid ${color.ink}`,
};
const sectionTitleStyle: React.CSSProperties = {
  fontSize: "1.05rem",
  fontWeight: 700,
  marginBottom: space.xs,
};
const tableNoteStyle: React.CSSProperties = {
  color: color.muted,
  fontSize: fontSize.xs,
  margin: `0 0 ${space.sm}`,
};
const footnoteStyle: React.CSSProperties = {
  color: color.muted,
  fontSize: "0.8rem",
  marginTop: "1.5rem",
};
