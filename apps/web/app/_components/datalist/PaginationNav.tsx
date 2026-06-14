import { tokens } from "@kimiterrace/ui";
import Link from "next/link";
import { type ListParams, listQueryString, pageCount } from "./list-params";

const { color, fontSize, radius, space } = tokens;

/**
 * UIUX-03: admin 一覧の共通ページャ (Server Component)。
 *
 * 「全 N 件」「page / pageCount」「前へ / 次へ」を描画する。リンクは現在の検索・フィルタ・
 * ソート条件を温存して page だけ動かす。全リストにページング必須 (全件スキャン廃止) の足場。
 */
export function PaginationNav({
  basePath,
  params,
  total,
}: {
  basePath: string;
  params: ListParams;
  total: number;
}) {
  const pages = pageCount(total, params.pageSize);
  const page = Math.min(params.page, pages);
  const start = total === 0 ? 0 : (page - 1) * params.pageSize + 1;
  const end = Math.min(total, page * params.pageSize);

  return (
    <nav aria-label="ページ送り" style={navStyle}>
      <span style={summaryStyle}>
        全 {total.toLocaleString("ja-JP")} 件中 {start.toLocaleString("ja-JP")}–
        {end.toLocaleString("ja-JP")} 件
      </span>
      <span style={pagerStyle}>
        {page > 1 ? (
          <Link
            href={`${basePath}${listQueryString(params, { page: page - 1 })}`}
            style={linkStyle}
          >
            ← 前へ
          </Link>
        ) : (
          <span style={disabledStyle}>← 前へ</span>
        )}
        <span style={pageNoStyle}>
          {page} / {pages}
        </span>
        {page < pages ? (
          <Link
            href={`${basePath}${listQueryString(params, { page: page + 1 })}`}
            style={linkStyle}
          >
            次へ →
          </Link>
        ) : (
          <span style={disabledStyle}>次へ →</span>
        )}
      </span>
    </nav>
  );
}

const navStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: space.md,
  marginTop: space.md,
  flexWrap: "wrap",
};
const summaryStyle: React.CSSProperties = { fontSize: fontSize.sm, color: color.muted };
const pagerStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: space.md };
const pageNoStyle: React.CSSProperties = { fontSize: fontSize.sm, color: color.ink };
const linkStyle: React.CSSProperties = {
  fontSize: fontSize.sm,
  color: color.primary,
  textDecoration: "none",
  border: `1px solid ${color.border}`,
  borderRadius: radius.sm,
  padding: `0.3rem ${space.md}`,
};
const disabledStyle: React.CSSProperties = {
  fontSize: fontSize.sm,
  color: color.border,
  border: `1px solid ${color.bgSoft}`,
  borderRadius: radius.sm,
  padding: `0.3rem ${space.md}`,
};
