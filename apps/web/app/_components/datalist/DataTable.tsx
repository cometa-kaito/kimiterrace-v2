import { tokens } from "@kimiterrace/ui";
import Link from "next/link";
import { type ListParams, listQueryString } from "./list-params";

const { color, fontSize, space } = tokens;

/**
 * UIUX-03: admin 一覧の共通テーブル (Server Component)。
 *
 * 列定義 + 整形済みセル (ReactNode) を受け取り、列ソートリンク付きの `<table>` を描画する。
 * ソートは URL (`?sort=&dir=`) 経由のサーバーサイド — クリックで同一ページに遷移し、
 * 呼び出し側のクエリ層が ORDER BY に反映する。並び替え可能列は `sortable: true` の列のみ
 * (クエリ層の sortKeys allowlist と一致させる)。色は tokens.ts 参照 (ハードコード廃止)。
 * 状態は記号 (▲/▼) + aria-sort で示し、色のみに依存しない (NFR05)。
 */

export type DataTableColumn = {
  key: string;
  label: string;
  sortable?: boolean;
  align?: "left" | "right";
};

export type DataTableRow = {
  key: string;
  cells: React.ReactNode[];
};

export function DataTable({
  basePath,
  params,
  columns,
  rows,
  empty = "該当するデータがありません。",
}: {
  basePath: string;
  params: ListParams;
  columns: readonly DataTableColumn[];
  rows: readonly DataTableRow[];
  empty?: string;
}) {
  if (rows.length === 0) {
    return <p style={emptyStyle}>{empty}</p>;
  }
  return (
    <div style={scrollStyle}>
      <table style={tableStyle}>
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                scope="col"
                aria-sort={
                  params.sort === col.key
                    ? params.dir === "asc"
                      ? "ascending"
                      : "descending"
                    : undefined
                }
                style={{ ...thStyle, textAlign: col.align ?? "left" }}
              >
                {col.sortable ? (
                  <SortLink basePath={basePath} params={params} col={col} />
                ) : (
                  col.label
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              {row.cells.map((cell, i) => (
                <td
                  // セルは列定義と 1:1 (並べ替えない) ため index キーで安定。
                  key={columns[i]?.key ?? i}
                  style={{ ...tdStyle, textAlign: columns[i]?.align ?? "left" }}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** ソート列ヘッダ: クリックで asc→desc をトグル (他列からの遷移は asc 開始)。page は 1 に戻す。 */
function SortLink({
  basePath,
  params,
  col,
}: {
  basePath: string;
  params: ListParams;
  col: DataTableColumn;
}) {
  const active = params.sort === col.key;
  const nextDir = active && params.dir === "asc" ? "desc" : "asc";
  const href = `${basePath}${listQueryString(params, { sort: col.key, dir: nextDir, page: null })}`;
  return (
    <Link href={href} style={active ? sortLinkActiveStyle : sortLinkStyle}>
      {col.label}
      <span aria-hidden="true" style={sortMarkStyle}>
        {active ? (params.dir === "asc" ? "▲" : "▼") : "△"}
      </span>
    </Link>
  );
}

const scrollStyle: React.CSSProperties = { overflowX: "auto" };
const emptyStyle: React.CSSProperties = { color: color.muted, padding: `${space.md} 0` };
const tableStyle: React.CSSProperties = { borderCollapse: "collapse", width: "100%" };
const thStyle: React.CSSProperties = {
  fontSize: fontSize.sm,
  color: color.muted,
  fontWeight: 600,
  padding: `${space.xs} ${space.sm}`,
  borderBottom: `1px solid ${color.border}`,
  whiteSpace: "nowrap",
};
const tdStyle: React.CSSProperties = {
  padding: `${space.sm} ${space.sm}`,
  borderBottom: `1px solid ${color.bgSoft}`,
  fontSize: fontSize.md,
  verticalAlign: "top",
};
const sortLinkStyle: React.CSSProperties = { color: color.muted, textDecoration: "none" };
const sortLinkActiveStyle: React.CSSProperties = { color: color.ink, textDecoration: "none" };
const sortMarkStyle: React.CSSProperties = { marginLeft: "0.25rem", fontSize: fontSize.xs };
