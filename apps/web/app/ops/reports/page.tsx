import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { SYSTEM_ADMIN_ROLES } from "@/lib/system-admin/roles";
import { type MonthlyReportListItem, listMonthlyReports } from "@kimiterrace/db";
import Link from "next/link";
import { DataTable } from "../../_components/datalist/DataTable";
import {
  type ListParams,
  type RawSearchParams,
  parseListParams,
} from "../../_components/datalist/list-params";

const BASE_PATH = "/ops/reports";

/**
 * PDF 履歴テーブルの列ソート allowlist (UIUX-03)。DataTable の列 key と 1 箇所で対応させる。
 * 既定は従来の `listMonthlyReports` の並び (対象月降順) に合わせる。
 */
const REPORT_SORT_KEYS = ["targetMonth", "schoolName", "pdfSizeBytes", "generatedAt"] as const;

/**
 * F09 (#45 / #430) / 実装設計書 §4「reports スリム化」: システム管理者の **学校向け月次レポート**画面
 * (`/ops/reports`)。**Server Component**。
 *
 * **学校向け月次レポート専用にスリム化した** (2026-06-13 判定)。従来の「広告主別レポート」ブロックは
 * 撤去した — 広告主向けの集計・PDF 配布は **portal に一元化**し (実装設計書 portal 判定4 / §26)、v2 と portal の
 * 二重開発を回避するため (広告主向けレポートのロードマップは v2 では中止)。本画面は **生成済み PDF 履歴**
 * (学校向け月次レポート) の一覧と認証付きダウンロード導線のみを担う。
 *
 * 生成バッチ (apps/jobs reports) が Cloud Storage へ保存し `monthly_reports` に記録した履歴を全校横断で
 * 一覧し、各行から PDF を **認証付き DL** (`/api/reports/{id}/download`) できる。
 *
 * UIUX-03: PDF 履歴テーブルは共通 DataTable で列ソート (`?sort=&dir=`、**メモリ内**) に対応する。
 * - **ページングは付けない**: 行数は「学校数 × 生成済み月数」規模 (現状 数十〜数百行) で、全件
 *   メモリ内ソート + 一括表示で十分。件数が四桁に達したら PaginationNav + SQL 側 limit/offset を検討。
 *
 * **認可**: `/admin` レイアウトの `requireRole(ADMIN_ROLES)` に加え、本ページは
 * `requireRole(SYSTEM_ADMIN_ROLES)` (system_admin のみ) に限定する。横断 (全校) レポートの閲覧/取得は
 * system_admin 専用で、school_admin / teacher は 403 (`/forbidden`)。月次レポートは運営の本ルートに
 * 一本化済みで、独立した自校用ルートは持たない (§43)。可視範囲は RLS が決める (system_admin=全校)。
 *
 * **アクセシビリティ (NFR05 / WCAG 2.2 AA)**: 数値は文字ラベル付きの `<table>` + `<th scope>` で提示し
 * 色のみに依存しない (PDF 履歴は DataTable が `aria-sort` を付す)。
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
  });

  // 生成済 PDF 履歴 (全校横断)。並び替えはメモリ内 (上記コメント参照)。
  const reports = sortReports(await withSession((tx) => listMonthlyReports(tx)), params);

  return (
    <section>
      <header style={headerStyle}>
        <h1 style={titleStyle}>学校向け月次レポート (システム管理)</h1>
      </header>

      <p style={subtitleStyle}>
        各学校向けに生成された月次レポート PDF
        の履歴です。広告主向けの集計・レポート配布は管理ポータル (portal) に一元化しています。
      </p>

      <h2 style={sectionTitleStyle}>生成済み PDF 履歴</h2>
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
        集計は日本時間 (JST) の暦月基準です。各レポートは対象学校のサイネージ掲示・反応
        (view/tap/ask) を 月次でまとめたものです。
      </p>
    </section>
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
  margin: "0 0 1.5rem",
};
const countStyle: React.CSSProperties = { fontSize: "0.85rem", color: "#6b7280" };
const dlLinkStyle: React.CSSProperties = { color: "#1d4ed8", fontSize: "0.85rem" };
const footnoteStyle: React.CSSProperties = {
  color: "#9ca3af",
  fontSize: "0.8rem",
  marginTop: "1.5rem",
};
