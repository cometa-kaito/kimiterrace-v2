"use client";

import { type NavGroup, activeNavHref } from "@/lib/nav";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useAdminMenu } from "./AdminMenu";
import { navIcon } from "./nav-icons";

/**
 * role 別サイドナビ (#48-C)。**クライアントコンポーネント** — 現在パスのハイライト
 * (`usePathname`) を扱う。モバイルの開閉状態は **ヘッダ右上のハンバーガーと共有**するため、
 * 自前 useState ではなく {@link useAdminMenu} から受け取る（ボタンはヘッダ、メニューはここ、と
 * DOM が分かれるため。ユーザー指摘 2026-06-16）。
 * nav 項目自体は Server (AppShell) で `navGroupsForRole(user.role)` から解決して props で渡す。
 *
 * **グループ表示 (2026-06-16 ユーザー要望)**: system_admin の 16 項目を目的別グループ + 見出しで
 * 整理する。`group.title` が空のグループ (school_admin / teacher の短いナビ) は見出しを描かず、
 * 従来どおりフラットに並べる。active 判定は全グループの項目を連結した最長一致で行う
 * （`activeNavHref`、グループ化しても判定ロジックは不変）。
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
  groups,
  menuFooter,
}: {
  groups: readonly NavGroup[];
  menuFooter?: ReactNode;
}) {
  const pathname = usePathname();
  const { open, setOpen } = useAdminMenu();
  // 最長一致のみを active にする（親 /app/school が子 /app/school/members で誤点灯するのを防ぐ）。
  // グループをまたいで全項目を連結してから判定する（active は nav 全体で 1 つ）。
  const activeHref = activeNavHref(
    groups.flatMap((group) => group.items),
    pathname,
  );

  return (
    <div className="admin-sidebar-wrap">
      <nav
        id="admin-nav"
        className="admin-nav"
        data-open={open ? "true" : "false"}
        aria-label="メインナビゲーション"
      >
        {groups.map((group, groupIndex) => (
          // 見出し付きグループ。title 空は見出しを描かず ul だけ（school_admin/teacher の従来表示）。
          <div
            className="admin-nav__section"
            // title はロール内で一意。空 title の先頭群は index でキー（1 グループのみ）。
            key={group.title || `group-${groupIndex}`}
          >
            {group.title ? <p className="admin-nav__group">{group.title}</p> : null}
            <ul>
              {group.items.map((item) => {
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
                      {navIcon(item.icon)}
                      <span className="admin-nav__label">{item.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
        {/* モバイル限定: ヘッダの操作群をハンバーガー内に畳む（globals.css `.admin-nav__footer`
            はデスクトップ display:none）。中の操作（ポータル/ログアウト）はいずれも画面遷移する
            ため、メニューは遷移で自然に閉じる（div への onClick は a11y 上付けない）。 */}
        {menuFooter ? <div className="admin-nav__footer">{menuFooter}</div> : null}
      </nav>
    </div>
  );
}
