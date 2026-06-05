"use client";

import type { NavItem } from "@/lib/nav";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

/**
 * role 別サイドナビ (#48-C)。**クライアントコンポーネント** — 現在パスのハイライト
 * (`usePathname`) と、モバイルのハンバーガー開閉 (`useState`) を扱う。
 * nav 項目自体は Server (AppShell) で `navItemsForRole(user.role)` から解決して props で渡す。
 *
 * レイアウト（デスクトップ=左サイドバー / モバイル=折りたたみ）は `globals.css` の
 * `.admin-*` クラス + メディアクエリで制御する。`data-open` でモバイル時の開閉を切り替える。
 */
export function Sidebar({ items }: { items: readonly NavItem[] }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  return (
    <div className="admin-sidebar-wrap">
      <button
        type="button"
        className="admin-hamburger"
        aria-expanded={open}
        aria-controls="admin-nav"
        onClick={() => setOpen((v) => !v)}
      >
        ☰ メニュー
      </button>
      <nav
        id="admin-nav"
        className="admin-nav"
        data-open={open ? "true" : "false"}
        aria-label="メインナビゲーション"
      >
        <ul>
          {items.map((item) => {
            // 完全一致 or 配下 (例: /admin/editor/123) を active 扱いにする。
            const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={isActive ? "page" : undefined}
                  // モバイルではリンク選択でメニューを閉じる。
                  onClick={() => setOpen(false)}
                >
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
