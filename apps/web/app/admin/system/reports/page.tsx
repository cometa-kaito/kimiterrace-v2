import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { SYSTEM_ADMIN_ROLES } from "@/lib/system-admin/roles";
import { type MonthlyReportListItem, listMonthlyReports } from "@kimiterrace/db";
import Link from "next/link";

/**
 * F09 (#45 / #430): システム管理者の月次レポート履歴一覧 (`/admin/system/reports`)。**Server Component**。
 *
 * 生成バッチ (apps/jobs reports) が Cloud Storage へ保存し `monthly_reports` に記録した履歴を、全校横断で
 * 一覧し、各行から PDF を **認証付き DL** (`/api/reports/{id}/download`、署名 URL 非発行) できる導線。
 *
 * **認可**: `/admin` レイアウトの `requireRole(ADMIN_ROLES)` に加え、本ページは
 * `requireRole(SYSTEM_ADMIN_ROLES)` (system_admin のみ) に限定する。横断 (全校) レポートの閲覧/取得は
 * system_admin 専用で、school_admin / teacher は 403 (`/forbidden`)。自校スコープの月次サマリー画面は
 * 別ルート (`/admin/reports`、PUBLISHER_ROLES) で存続する。
 *
 * 可視範囲は monthly_reports の RLS が決める (system_admin=全校 / それ以外=自校のみ)。本ページは
 * system_admin 専用なので全校の履歴が新しい月順に並ぶ (`listMonthlyReports`)。
 */
export default async function SystemReportsPage() {
  await requireRole(SYSTEM_ADMIN_ROLES);
  const reports = await withSession((tx) => listMonthlyReports(tx));

  return (
    <section>
      <header style={headerStyle}>
        <h1 style={titleStyle}>月次レポート履歴</h1>
        <span style={countStyle}>{reports.length} 件</span>
      </header>

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
    </section>
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
const countStyle: React.CSSProperties = { fontSize: "0.85rem", color: "#6b7280" };
const emptyStyle: React.CSSProperties = { color: "#6b7280" };
const tableStyle: React.CSSProperties = { borderCollapse: "collapse", width: "100%" };
const thStyle: React.CSSProperties = {
  textAlign: "left",
  fontSize: "0.85rem",
  color: "#6b7280",
  padding: "0.4rem 0.6rem",
  borderBottom: "1px solid #e5e7eb",
};
const tdStyle: React.CSSProperties = {
  padding: "0.5rem 0.6rem",
  borderBottom: "1px solid #f3f4f6",
  fontSize: "0.9rem",
};
const dlLinkStyle: React.CSSProperties = { color: "#1d4ed8", fontSize: "0.85rem" };
