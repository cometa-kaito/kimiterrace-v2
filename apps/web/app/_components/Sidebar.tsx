"use client";

import { type NavItem, activeNavHref } from "@/lib/nav";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useAdminMenu } from "./AdminMenu";

/**
 * role 別サイドナビ (#48-C)。**クライアントコンポーネント** — 現在パスのハイライト
 * (`usePathname`) を扱う。モバイルの開閉状態は **ヘッダ右上のハンバーガーと共有**するため、
 * 自前 useState ではなく {@link useAdminMenu} から受け取る（ボタンはヘッダ、メニューはここ、と
 * DOM が分かれるため。ユーザー指摘 2026-06-16）。
 * nav 項目自体は Server (AppShell) で `navItemsForRole(user.role)` から解決して props で渡す。
 *
 * レイアウト（デスクトップ=左サイドバー / モバイル=折りたたみ）は `globals.css` の
 * `.admin-*` クラス + メディアクエリで制御する。`data-open` でモバイル時の開閉を切り替える
 * （デスクトップは media-query 側で常時表示＝ data-open を無視）。
 *
 * `menuFooter`: モバイルでは「ヘッダの操作群（ロール/メール/ポータル/ログアウト）を全部
 * ハンバーガーの中に畳む」方針（ユーザー指摘 2026-06-16）。AppShell から操作群を受け取り、
 * ドロップダウン（`.admin-nav`）の末尾に出す。デスクトップでは `.admin-nav__footer` が
 * `display:none`（操作群はヘッダ右に出る）なので、ここに渡しても二重表示にはならない。
 */
export function Sidebar({
  items,
  menuFooter,
}: {
  items: readonly NavItem[];
  menuFooter?: ReactNode;
}) {
  const pathname = usePathname();
  const { open, setOpen } = useAdminMenu();
  // 最長一致のみを active にする（親 /app/school が子 /app/school/members で誤点灯するのを防ぐ）。
  const activeHref = activeNavHref(items, pathname);

  return (
    <div className="admin-sidebar-wrap">
      <nav
        id="admin-nav"
        className="admin-nav"
        data-open={open ? "true" : "false"}
        aria-label="メインナビゲーション"
      >
        <ul>
          {items.map((item) => {
            // 完全一致 or 配下 (例: /app/editor/123) のうち最長一致のみ active（activeNavHref）。
            const isActive = item.href === activeHref;
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
        {/* モバイル限定: ヘッダの操作群をハンバーガー内に畳む（globals.css `.admin-nav__footer`
            はデスクトップ display:none）。中の操作（ポータル/ログアウト）はいずれも画面遷移する
            ため、メニューは遷移で自然に閉じる（div への onClick は a11y 上付けない）。 */}
        {menuFooter ? <div className="admin-nav__footer">{menuFooter}</div> : null}
      </nav>
    </div>
  );
}
