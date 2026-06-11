import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import {
  DASHBOARD_SORT_KEYS,
  defaultDashboardRange,
  getEventStatsBySchoolRange,
  sortSchoolSummaries,
} from "@/lib/system-admin/dashboard-stats";
import { SYSTEM_ADMIN_ROLES } from "@/lib/system-admin/roles";
import { tokens } from "@kimiterrace/ui";
import { DataListControls } from "../../_components/datalist/DataListControls";
import { DataTable } from "../../_components/datalist/DataTable";
import {
  type RawSearchParams,
  dateRangeBounds,
  parseListParams,
} from "../../_components/datalist/list-params";

const { color, fontSize, space } = tokens;

const BASE_PATH = "/admin/system/dashboard";

/**
 * F08 (#44) 第4スライス / UIUX-03: システム管理者の **全校横断ダッシュボード**
 * (`/admin/system/dashboard`)。**Server Component**。
 *
 * F08 第1〜3スライス (`/admin/dashboard`) が school_admin / teacher の**自校**ビューを担うのに対し、
 * 本ページは運営 (system_admin) が全校の活動量を横断で把握するための**学校別サマリー**を提供する。
 *
 * UIUX-03: 従来の「直近 30 日固定」を共通 DataList 基盤の**日付範囲ピッカー** (`?from=&to=`) に
 * 置換した。未指定時は従来どおり直近 30 日 (JST 暦日、`defaultDashboardRange`)。学校別テーブルは
 * DataTable 化して列ソート (`?sort=&dir=`、メモリ内) に対応する。集計は
 * `getEventStatsBySchoolRange` (apps/web/lib、packages/db `getEventStatsBySchool` の期間指定版)。
 *
 * **認可**: `/admin` レイアウトの `requireRole(ADMIN_ROLES)` に加え `requireRole(SYSTEM_ADMIN_ROLES)`
 * (system_admin のみ)。school_admin / teacher は 403 (`/forbidden`)。横断データを自校ビューに混ぜない
 * (#166 / F08 第1スライスと同方針)。実データの越境は events / schools の RLS
 * (`system_admin_full_access`、ADR-019) が DB レベルで強制する (CLAUDE.md ルール2、多層防御)。
 *
 * `withSession` で RLS context を張り集計する。集計は件数のみで `events.payload` の匿名 clientId は
 * 読まない (ルール4)。重い描画ライブラリは導入しない。
 *
 * **アクセシビリティ (NFR05 / WCAG 2.2 AA)**: 学校別サマリーは DataTable (`<table>` + `<th scope>` +
 * `aria-sort`) で提示し、数値は文字ラベル付きで色のみに依存しない。
 */
export default async function SystemDashboardPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  await requireRole(SYSTEM_ADMIN_ROLES);
  const params = parseListParams(await searchParams, {
    sortKeys: DASHBOARD_SORT_KEYS,
    defaultSort: "reactions",
    defaultDir: "desc",
  });

  // 期間解決: from/to が片方でも指定されていればそれを尊重 (片側 open-ended)。
  // 両方未指定なら従来どおり「直近 30 日」(JST 暦日) を既定にする。
  const hasExplicitRange = params.from !== null || params.to !== null;
  const range = hasExplicitRange ? { from: params.from, to: params.to } : defaultDashboardRange();
  // JST 暦日 → timestamptz 境界は dateRangeBounds (明示 +09:00、セッション TZ 非依存) に集約。
  const { since, untilExclusive } = dateRangeBounds(range);

  const schools = await withSession((tx) =>
    getEventStatsBySchoolRange(tx, { since, untilExclusive }),
  );
  const sorted = sortSchoolSummaries(schools, params);

  // 全校合算 (ヘッダのサマリーカード用)。ソート非依存なので元配列から畳む。
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
        期間: {fromLabel}〜{toLabel}（未指定時は直近30日）・全校横断の反応（活動のあった{" "}
        {schools.length} 校）
      </p>

      <DataListControls basePath={BASE_PATH} params={params} dateRange dateRangeLabel="期間" />

      <div style={cardsStyle}>
        <SummaryCard label="延べ表示数 (engagement)" value={overall.view} />
        <SummaryCard label="タップ (tap)" value={overall.tap} />
        <SummaryCard label="Q&A (ask)" value={overall.ask} />
      </div>

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
        rows={sorted.map((s) => ({
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

      {/* ADR-025: 延べ表示数(engagement) と 広告主向け到達数(reach) を取り違えないよう明示する。 */}
      <p style={footnoteStyle}>
        「延べ表示数
        (engagement)」は表示の延べ回数で、同じ内容を複数回・複数端末で表示した分も数えます。
        広告主向けの「到達数 (reach)」は別指標 (重複排除済) です。
      </p>
    </section>
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
  marginBottom: "1.75rem",
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
