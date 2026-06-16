import Link from "next/link";
import { type ListParams, listQueryString } from "./list-params";

/**
 * UIUX-03: admin 一覧の共通テーブル (Server Component)。
 *
 * 列定義 + 整形済みセル (ReactNode) を受け取り、列ソートリンク付きの `<table>` を描画する。
 * ソートは URL (`?sort=&dir=`) 経由のサーバーサイド — クリックで同一ページに遷移し、
 * 呼び出し側のクエリ層が ORDER BY に反映する。並び替え可能列は `sortable: true` の列のみ
 * (クエリ層の sortKeys allowlist と一致させる)。状態は記号 (▲/▼) + aria-sort で示し、
 * 色のみに依存しない (NFR05)。
 *
 * **レスポンシブ (2026-06-16 デザイン刷新)**: 配色・寸法は `globals.css` の `.kt-table*` クラスに
 * 集約し (インライン style 廃止)、狭幅 (<=640px) では 1 行 = 1 カードに畳む (横スクロールの代わり)。
 * 各 `<td>` は `data-label` に列見出しを持ち、カード表示時に `::before` でラベルを左、値を右に並べる
 * (見やすさ)。**a11y**: `<thead>` は狭幅でも DOM/AT に残し (sr-only でクリップ) `<th scope="col">` +
 * `aria-sort` を維持する = テーブルセマンティクス・読み上げを壊さずに見た目だけカード化する。
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
    return <p className="kt-table__empty">{empty}</p>;
  }
  return (
    <div className="kt-table-scroll">
      <table className="kt-table">
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
                className={col.align === "right" ? "kt-right" : undefined}
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
                  // 狭幅カード表示で `::before` に出す列見出し (操作列など label 空はラベル無し)。
                  data-label={columns[i]?.label ?? ""}
                  className={columns[i]?.align === "right" ? "kt-right" : undefined}
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
    <Link href={href} className="kt-sort" data-active={active ? "true" : "false"}>
      {col.label}
      <span aria-hidden="true" className="kt-sort__mark">
        {active ? (params.dir === "asc" ? "▲" : "▼") : "△"}
      </span>
    </Link>
  );
}
