"use client";

import type { NavItem } from "@/lib/nav";
import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * role 別サイドナビ (#48-C)。**クライアントコンポーネント** — 現在パスのハイライトに
 * `usePathname` を使うため。nav 項目自体は Server (layout) で `navItemsForRole(user.role)`
 * から解決して props で渡す (role 判定をクライアントに持ち込まない)。
 */
export function Sidebar({ items }: { items: readonly NavItem[] }) {
  const pathname = usePathname();

  return (
    <nav aria-label="メインナビゲーション" style={navStyle}>
      <ul style={listStyle}>
        {items.map((item) => {
          // 完全一致 or 配下 (例: /admin/editor/123) を active 扱いにする。
          const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={isActive ? "page" : undefined}
                style={{ ...linkStyle, ...(isActive ? activeLinkStyle : null) }}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

const navStyle: React.CSSProperties = {
  width: "220px",
  flexShrink: 0,
  borderRight: "1px solid #e5e7eb",
  padding: "1rem 0.5rem",
  background: "#fafafa",
};

const listStyle: React.CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: "0.25rem",
};

const linkStyle: React.CSSProperties = {
  display: "block",
  padding: "0.5rem 0.75rem",
  borderRadius: "6px",
  color: "#374151",
  textDecoration: "none",
  fontSize: "0.95rem",
};

const activeLinkStyle: React.CSSProperties = {
  background: "#1f2937",
  color: "#fff",
  fontWeight: 600,
};
