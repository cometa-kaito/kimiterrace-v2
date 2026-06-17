import { tokens } from "@kimiterrace/ui";
import Link from "next/link";
import type { CSSProperties } from "react";

/**
 * パンくず 1 項目。`label` が意味の本体（学校名・クラス名・画面名など）。
 * `href` 省略時はリンクにせず現在地（末尾と同じ非リンク表現）として扱う。
 */
export type BreadcrumbItem = {
  label: string;
  /** リンク先パス。省略 = リンクにしない（中間の非リンク見出しや現在地）。 */
  href?: string;
};

/**
 * 管理画面（`/ops`・`/app`）共通のパンくず。これまで各ページが `<nav>` + `<Link>` +
 * インライン style（生 hex `#2563eb` 等）で個別に組んでいたものを 1 つに集約し、色・余白・
 * 文字サイズを `@kimiterrace/ui` の {@link tokens} に単一ソース化する（ブランド変更時の grep を撤廃）。
 *
 * **配置の理由**: パンくずは `next/link` によるルーティング chrome なので、framework 非依存の共通
 * プリミティブ（`packages/ui`）ではなく、同じく `next/link` を直接使う {@link Sidebar} と同列に
 * `apps/web/app/_components/` へ置く。
 *
 * **a11y**: `<nav aria-label>` + 順序リスト `<ol>`（階層の順序を意味づけ）。末尾項目は現在地として
 * `aria-current="page"` を付け、リンクにしない。区切り "/" は装飾なので `aria-hidden`（読み上げ対象外）。
 * 「リンク色 + 現在地は非リンクテキスト」で色のみに依存せず区別する（NFR05）。
 *
 * **Server Component**（hover 状態を持たないので JS 不要）。リンクは `next/link` で
 * クライアント遷移・prefetch を維持する。
 *
 * @example
 * <Breadcrumb
 *   items={[
 *     { label: "学校一覧", href: "/ops/schools" },
 *     { label: school.name, href: `/ops/schools/${school.id}` },
 *     { label: "クラス設定" },
 *   ]}
 * />
 */
export function Breadcrumb({ items }: { items: BreadcrumbItem[] }) {
  if (items.length === 0) {
    return null;
  }
  return (
    <nav aria-label="パンくず" style={navStyle}>
      <ol style={listStyle}>
        {items.map((item, i) => {
          const isLast = i === items.length - 1;
          return (
            <li key={`${item.href ?? ""}/${item.label}`} style={itemStyle}>
              {item.href && !isLast ? (
                <Link href={item.href} style={linkStyle}>
                  {item.label}
                </Link>
              ) : (
                <span aria-current={isLast ? "page" : undefined} style={currentStyle}>
                  {item.label}
                </span>
              )}
              {isLast ? null : (
                <span aria-hidden="true" style={sepStyle}>
                  /
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

const navStyle: CSSProperties = { fontSize: tokens.fontSize.sm };
const listStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: tokens.space.sm,
  margin: 0,
  padding: 0,
  listStyle: "none",
  color: tokens.color.muted,
};
const itemStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: tokens.space.sm,
};
const linkStyle: CSSProperties = { color: tokens.color.blueStrong, textDecoration: "none" };
const currentStyle: CSSProperties = { color: tokens.color.ink };
const sepStyle: CSSProperties = { color: tokens.color.muted };
