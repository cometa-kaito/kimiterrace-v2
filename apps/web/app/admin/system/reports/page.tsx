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

/**
 * F09 (#45 / #430): システム管理者の月次レポート画面 (`/admin/system/reports`)。**Server Component**。
 *
 * 2 つのブロックを持つ:
 *  1. **広告主別レポート** (#45): 対象 JST 暦月で、広告主アカウントごとの反応 (タップ・Q&A・延べ表示) を
 *     全校横断で集計して表示する (`getMonthlyAdvertiserReport`)。広告主は CRM の `advertisers` を主語に、
 *     `contracts ⟶ contract_contents ⟶ contents ⟶ events` をたどって帰属する。対面コミュニケーション用の
 *     数値サマリー (F09 受け入れ条件「広告主別レポート: タップ・Q&A 件数」)。
 *  2. **生成済 PDF 履歴**: 生成バッチ (apps/jobs reports) が Cloud Storage へ保存し `monthly_reports` に
 *     記録した履歴を全校横断で一覧し、各行から PDF を **認証付き DL** (`/api/reports/{id}/download`) できる導線。
 *
 * **認可**: `/admin` レイアウトの `requireRole(ADMIN_ROLES)` に加え、本ページは
 * `requireRole(SYSTEM_ADMIN_ROLES)` (system_admin のみ) に限定する。横断 (全校) レポートの閲覧/取得は
 * system_admin 専用で、school_admin / teacher は 403 (`/forbidden`)。自校スコープの月次サマリー画面は
 * 別ルート (`/admin/reports`、PUBLISHER_ROLES) で存続する。可視範囲は RLS が決める (system_admin=全校)。
 * CRM 表は `system_admin_full_access` policy のみを持つため、広告主別集計は system_admin context でのみ
 * 行を返す (`withSession` は system_admin の role/uid で RLS context を張る、ルール2)。
 *
 * **アクセシビリティ (NFR05 / WCAG 2.2 AA)**: 数値は文字ラベル付きの `<table>` + `<th scope>` で提示し
 * 色のみに依存しない。対象月ナビは `<nav>` + リンクテキストで読み上げ可能にする。
 */
export default async function SystemReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ ym?: string }>;
}) {
  await requireRole(SYSTEM_ADMIN_ROLES);

  const current = currentJstYearMonth();
  // ?ym=YYYY-MM を検証。不正・未指定・未来月は現在の JST 暦月へ丸める (未来はデータ不在のため)。
  const requested = parseYearMonth((await searchParams).ym);
  const target = requested && !isAfterMonth(requested, current) ? requested : current;

  // 広告主別の月次集計 (全校横断、system_admin context)。CRM 表は RLS で system_admin のみ可視。
  const advertiserReport = await withSession((tx) =>
    getMonthlyAdvertiserReport(tx, { year: target.year, month: target.month }),
  );
  // 生成済 PDF 履歴 (全校横断、対象月に依存しない一覧)。
  const reports = await withSession((tx) => listMonthlyReports(tx));

  const prev = shiftMonth(target, -1);
  const next = shiftMonth(target, +1);
  // 翌月リンクは「現在月より前のときだけ」有効 (未来月はデータ不在で打ち止め)。
  const hasNext = !isSameMonth(target, current);

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
        <Link style={navLinkStyle} href={`?ym=${toYmParam(prev)}`} rel="prev" prefetch={false}>
          ← {formatYm(prev)}
        </Link>
        <span style={monthLabelStyle} aria-current="date">
          {formatYm(target)}
        </span>
        {hasNext ? (
          <Link style={navLinkStyle} href={`?ym=${toYmParam(next)}`} rel="next" prefetch={false}>
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

      {reports.length === 0 ? (
        <p style={emptyStyle}>生成済みの月次レポートがありません。</p>
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>対象月</th>
              <th style={thStyle}>学校名</th>
              <th style={thStyle}>サイズ</th>
              <th style={thStyle}>生成日時</th>
              <th style={thStyle} />
            </tr>
          </thead>
          <tbody>
            {reports.map((r) => (
              <tr key={r.id}>
                <td style={tdStyle}>{formatYearMonth(r.targetYear, r.targetMonth)}</td>
                <td style={{ ...tdStyle, fontWeight: 600 }}>{r.schoolName}</td>
                <td style={tdStyle}>{formatBytes(r.pdfSizeBytes)}</td>
                <td style={tdStyle}>{formatJstDateTime(r.generatedAt)}</td>
                <td style={tdStyle}>
                  <Link href={`/api/reports/${r.id}/download`} style={dlLinkStyle} prefetch={false}>
                    PDF ダウンロード
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

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
const tableStyle: React.CSSProperties = { borderCollapse: "collapse", width: "100%" };
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
const thStyle: React.CSSProperties = {
  textAlign: "left",
  fontSize: "0.85rem",
  color: "#6b7280",
  padding: "0.4rem 0.6rem",
  borderBottom: "1px solid #e5e7eb",
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
const tdStyle: React.CSSProperties = {
  padding: "0.5rem 0.6rem",
  borderBottom: "1px solid #f3f4f6",
  fontSize: "0.9rem",
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
