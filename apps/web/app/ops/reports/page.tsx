import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import {
  currentJstYearMonth,
  formatYearMonth as formatYm,
  isAfterMonth,
  isSameMonth,
  parseYearMonth,
  shiftMonth,
  toYmParam,
} from "@/lib/reports/month";
import { SYSTEM_ADMIN_ROLES } from "@/lib/system-admin/roles";
import {
  type AdvertiserMonthlyReport,
  type MonthlyReportListItem,
  getMonthlyAdvertiserReport,
  listMonthlyReports,
} from "@kimiterrace/db";
import Link from "next/link";
import { DataTable } from "../../_components/datalist/DataTable";
import {
  type ListParams,
  type RawSearchParams,
  listQueryString,
  parseListParams,
} from "../../_components/datalist/list-params";

const BASE_PATH = "/ops/reports";

/**
 * PDF 履歴テーブルの列ソート allowlist (UIUX-03)。DataTable の列 key と 1 箇所で対応させる。
 * 既定は従来の `listMonthlyReports` の並び (対象月降順) に合わせる。
 */
const REPORT_SORT_KEYS = ["targetMonth", "schoolName", "pdfSizeBytes", "generatedAt"] as const;

/**
 * F09 (#45 / #430): システム管理者の月次レポート画面 (`/ops/reports`)。**Server Component**。
 *
 * 2 つのブロックを持つ:
 *  1. **広告主別レポート** (#45): 対象 JST 暦月で、広告主アカウントごとの反応 (タップ・Q&A・延べ表示) を
 *     全校横断で集計して表示する (`getMonthlyAdvertiserReport`)。広告主は CRM の `advertisers` を主語に、
 *     `contracts ⟶ contract_contents ⟶ contents ⟶ events` をたどって帰属する。対面コミュニケーション用の
 *     数値サマリー (F09 受け入れ条件「広告主別レポート: タップ・Q&A 件数」)。
 *  2. **生成済 PDF 履歴**: 生成バッチ (apps/jobs reports) が Cloud Storage へ保存し `monthly_reports` に
 *     記録した履歴を全校横断で一覧し、各行から PDF を **認証付き DL** (`/api/reports/{id}/download`) できる導線。
 *
 * UIUX-03: PDF 履歴テーブルを共通 DataTable 化し、列ソート (`?sort=&dir=`、**メモリ内**) を付けた。
 * - 月ナビの `?ym=` は filterKeys 経由で `ListParams.filters` に通し、ソートリンク (listQueryString) が
 *   ym を温存する / 月ナビリンクがソート状態を温存する、の両立を URL 1 本で実現する。
 * - **ページングは付けない**: 行数は「学校数 × 生成済み月数」規模 (現状 数十〜数百行) で、全件
 *   メモリ内ソート + 一括表示で十分。件数が四桁に達したら PaginationNav + SQL 側 limit/offset を検討。
 * - 広告主別テーブルは DataTable 化**しない**: 同一 URL の `?sort=` を 2 テーブルで共有すると列 key が
 *   衝突する。広告主別は「合計反応数が多い順」のランキング表示が仕様 (F09) のため固定順のまま温存する。
 *
 * **認可**: `/admin` レイアウトの `requireRole(ADMIN_ROLES)` に加え、本ページは
 * `requireRole(SYSTEM_ADMIN_ROLES)` (system_admin のみ) に限定する。横断 (全校) レポートの閲覧/取得は
 * system_admin 専用で、school_admin / teacher は 403 (`/forbidden`)。自校スコープの月次サマリー画面は
 * 別ルート (`/app/reports`、PUBLISHER_ROLES) で存続する。可視範囲は RLS が決める (system_admin=全校)。
 * CRM 表は `system_admin_full_access` policy のみを持つため、広告主別集計は system_admin context でのみ
 * 行を返す (`withSession` は system_admin の role/uid で RLS context を張る、ルール2)。
 *
 * **アクセシビリティ (NFR05 / WCAG 2.2 AA)**: 数値は文字ラベル付きの `<table>` + `<th scope>` で提示し
 * 色のみに依存しない (PDF 履歴は DataTable が `aria-sort` を付す)。対象月ナビは `<nav>` + リンクテキスト
 * で読み上げ可能にする。
 */
export default async function SystemReportsPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  await requireRole(SYSTEM_ADMIN_ROLES);

  const params = parseListParams(await searchParams, {
    sortKeys: REPORT_SORT_KEYS,
    defaultSort: "targetMonth",
    defaultDir: "desc",
    // ?ym= (月ナビ) を filters に通して、ソートリンク往復で月選択が消えないようにする。
    filterKeys: ["ym"],
  });

  const current = currentJstYearMonth();
  // ?ym=YYYY-MM を検証。不正・未指定・未来月は現在の JST 暦月へ丸める (未来はデータ不在のため)。
  const requested = parseYearMonth(params.filters.ym);
  const target = requested && !isAfterMonth(requested, current) ? requested : current;

  // 広告主別の月次集計 (全校横断、system_admin context)。CRM 表は RLS で system_admin のみ可視。
  const advertiserReport = await withSession((tx) =>
    getMonthlyAdvertiserReport(tx, { year: target.year, month: target.month }),
  );
  // 生成済 PDF 履歴 (全校横断、対象月に依存しない一覧)。並び替えはメモリ内 (上記コメント参照)。
  const reports = sortReports(await withSession((tx) => listMonthlyReports(tx)), params);

  const prev = shiftMonth(target, -1);
  const next = shiftMonth(target, +1);
  // 翌月リンクは「現在月より前のときだけ」有効 (未来月はデータ不在で打ち止め)。
  const hasNext = !isSameMonth(target, current);
  // 月ナビは listQueryString で組み、ソート状態 (?sort=&dir=) を温存したまま ym だけ差し替える。
  const monthHref = (ym: { year: number; month: number }) =>
    `${BASE_PATH}${listQueryString(params, { filters: { ym: toYmParam(ym) }, page: null })}`;

  return (
    <section>
      <header style={headerStyle}>
        <h1 style={titleStyle}>月次レポート (システム管理)</h1>
      </header>

      <h2 style={sectionTitleStyle}>広告主別レポート</h2>
      <p style={subtitleStyle}>
        広告主アカウントごとの反応 (タップ・Q&A・延べ表示) を全校横断で月次集計します
        (対面コミュニケーション用)。
      </p>

      <nav style={monthNavStyle} aria-label="対象月の切り替え">
        <Link style={navLinkStyle} href={monthHref(prev)} rel="prev" prefetch={false}>
          ← {formatYm(prev)}
        </Link>
        <span style={monthLabelStyle} aria-current="date">
          {formatYm(target)}
        </span>
        {hasNext ? (
          <Link style={navLinkStyle} href={monthHref(next)} rel="next" prefetch={false}>
            {formatYm(next)} →
          </Link>
        ) : (
          <span style={navLinkDisabledStyle} aria-disabled="true">
            {formatYm(next)} →
          </span>
        )}
      </nav>

      {advertiserReport.length === 0 ? (
        <p style={emptyStyle}>登録済みの広告主がいません。</p>
      ) : (
        <table style={metricTableStyle}>
          <caption style={captionStyle}>
            {formatYm(target)}の広告主別 反応集計 (合計反応数が多い順)。同じ反応 event
            を複数契約で重複計上しません。
          </caption>
          <thead>
            <tr>
              <th scope="col" style={thLeftStyle}>
                広告主
              </th>
              <th scope="col" style={thNumStyle}>
                タップ
              </th>
              <th scope="col" style={thNumStyle}>
                Q&A
              </th>
              <th scope="col" style={thNumStyle}>
                延べ表示
              </th>
              <th scope="col" style={thNumStyle}>
                合計
              </th>
            </tr>
          </thead>
          <tbody>
            {advertiserReport.map((row) => (
              <AdvertiserRow key={row.advertiserId} row={row} />
            ))}
          </tbody>
        </table>
      )}

      <h2 style={{ ...sectionTitleStyle, marginTop: "2.25rem" }}>生成済み PDF 履歴</h2>
      <p style={countStyle}>{reports.length} 件</p>

      <DataTable
        basePath={BASE_PATH}
        params={params}
        empty="生成済みの月次レポートがありません。"
        columns={[
          { key: "targetMonth", label: "対象月", sortable: true },
          { key: "schoolName", label: "学校名", sortable: true },
          { key: "pdfSizeBytes", label: "サイズ", sortable: true },
          { key: "generatedAt", label: "生成日時", sortable: true },
          { key: "actions", label: "" },
        ]}
        rows={reports.map((r) => ({
          key: r.id,
          cells: [
            formatYearMonth(r.targetYear, r.targetMonth),
            <strong key="school">{r.schoolName}</strong>,
            formatBytes(r.pdfSizeBytes),
            formatJstDateTime(r.generatedAt),
            <Link
              key="dl"
              href={`/api/reports/${r.id}/download`}
              style={dlLinkStyle}
              prefetch={false}
            >
              PDF ダウンロード
            </Link>,
          ],
        }))}
      />

      <p style={footnoteStyle}>
        集計は日本時間 (JST)
        の暦月基準です。広告主別の反応は、その広告主の契約に紐づく出稿コンテンツへの view/tap/ask を
        event 単位で重複排除して数えます (掲示に紐づかない一般 Q&A
        は特定の広告主に帰属しません)。広告主別 PDF の生成・配布は今後のスライスで追加します。
      </p>
    </section>
  );
}

/** 広告主別レポート 1 行。会社名は行見出し (`<th scope="row">`)、数値はタブ揃え。 */
function AdvertiserRow({ row }: { row: AdvertiserMonthlyReport }) {
  return (
    <tr>
      <th scope="row" style={tdLeftStyle}>
        {row.companyName}
      </th>
      <td style={tdNumStyle}>{row.taps.toLocaleString("ja-JP")}</td>
      <td style={tdNumStyle}>{row.asks.toLocaleString("ja-JP")}</td>
      <td style={tdNumStyle}>{row.views.toLocaleString("ja-JP")}</td>
      <td style={tdNumTotalStyle}>{row.total.toLocaleString("ja-JP")}</td>
    </tr>
  );
}

/** ソートキー → 比較値。対象月は year*100+month の数値で年→月の辞書順にする。 */
function reportSortValue(r: MonthlyReportListItem, key: string): string | number {
  switch (key) {
    case "schoolName":
      return r.schoolName;
    case "pdfSizeBytes":
      return r.pdfSizeBytes;
    case "generatedAt":
      return r.generatedAt.getTime();
    default:
      return r.targetYear * 100 + r.targetMonth;
  }
}

/**
 * PDF 履歴を **メモリ内**で並べ替える (非破壊)。行数は学校数 × 月数規模なので SQL に持ち込まない
 * (ページ docstring 参照)。同値は dir に依らず 学校名 → id 昇順で決定的にする (既定ソートの
 * 「対象月降順 → 校名昇順 → id 昇順」が従来の `listMonthlyReports` の並びと一致する)。
 */
function sortReports(
  rows: readonly MonthlyReportListItem[],
  params: Pick<ListParams, "sort" | "dir">,
): MonthlyReportListItem[] {
  const sign = params.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = reportSortValue(a, params.sort);
    const vb = reportSortValue(b, params.sort);
    const primary =
      typeof va === "number" && typeof vb === "number"
        ? va - vb
        : String(va).localeCompare(String(vb), "ja");
    if (primary !== 0) {
      return primary * sign;
    }
    return a.schoolName.localeCompare(b.schoolName, "ja") || a.id.localeCompare(b.id);
  });
}

/** 対象年月を `YYYY年M月` で表示する (ゼロ詰めしない、日本語月)。 */
function formatYearMonth(year: number, month: number): string {
  return `${year}年${month}月`;
}

/** PDF バイト数を人間可読な単位 (KB/MB) で表示する。 */
function formatBytes(bytes: MonthlyReportListItem["pdfSizeBytes"]): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(1)} KB`;
  }
  return `${(kb / 1024).toFixed(1)} MB`;
}

/** generatedAt を JST の YYYY/MM/DD HH:mm で表示する (サーバー描画、ロケール固定)。 */
function formatJstDateTime(value: Date): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  marginBottom: "1rem",
};
const titleStyle: React.CSSProperties = { fontSize: "1.3rem", fontWeight: 700 };
const sectionTitleStyle: React.CSSProperties = {
  fontSize: "1.05rem",
  fontWeight: 700,
  marginBottom: "0.5rem",
};
const subtitleStyle: React.CSSProperties = {
  color: "#6b7280",
  fontSize: "0.85rem",
  margin: "0 0 1rem",
};
const countStyle: React.CSSProperties = { fontSize: "0.85rem", color: "#6b7280" };
const emptyStyle: React.CSSProperties = { color: "#6b7280" };
const metricTableStyle: React.CSSProperties = {
  borderCollapse: "collapse",
  width: "100%",
  fontSize: "0.9rem",
};
const monthNavStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "1rem",
  marginBottom: "1rem",
};
const navLinkStyle: React.CSSProperties = {
  color: "#2563eb",
  textDecoration: "none",
  fontSize: "0.9rem",
  fontWeight: 600,
};
const navLinkDisabledStyle: React.CSSProperties = {
  color: "#9ca3af",
  fontSize: "0.9rem",
  fontWeight: 600,
  cursor: "default",
};
const monthLabelStyle: React.CSSProperties = {
  fontSize: "1.05rem",
  fontWeight: 700,
  minWidth: "8rem",
  textAlign: "center",
};
const captionStyle: React.CSSProperties = {
  textAlign: "left",
  color: "#6b7280",
  fontSize: "0.8rem",
  marginBottom: "0.5rem",
};
const thLeftStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "0.5rem 0.6rem",
  borderBottom: "2px solid #e5e7eb",
  fontWeight: 600,
};
const thNumStyle: React.CSSProperties = {
  textAlign: "right",
  padding: "0.5rem 0.6rem",
  borderBottom: "2px solid #e5e7eb",
  fontWeight: 600,
  width: "5.5rem",
};
const tdLeftStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "0.5rem 0.6rem",
  borderBottom: "1px solid #f3f4f6",
  fontWeight: 500,
};
const tdNumStyle: React.CSSProperties = {
  textAlign: "right",
  padding: "0.5rem 0.6rem",
  borderBottom: "1px solid #f3f4f6",
  fontVariantNumeric: "tabular-nums",
};
const tdNumTotalStyle: React.CSSProperties = { ...tdNumStyle, fontWeight: 700 };
const dlLinkStyle: React.CSSProperties = { color: "#1d4ed8", fontSize: "0.85rem" };
const footnoteStyle: React.CSSProperties = {
  color: "#9ca3af",
  fontSize: "0.8rem",
  marginTop: "1.5rem",
};
