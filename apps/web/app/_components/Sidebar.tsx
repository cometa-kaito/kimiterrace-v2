"use client";

import { type NavGroup, type NavItem, activeNavHref } from "@/lib/nav";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

/**
 * role 別サイドナビ (#48-C / 運営整理 Phase7 §7 でグループ折りたたみ対応)。
 * **クライアントコンポーネント** — 現在パスのハイライト (`usePathname`)、モバイルのハンバーガー
 * 開閉、グループ（配信運用 / ログ・監査）の折りたたみ (`useState`) を扱う。nav グループ自体は
 * Server (AppShell) で `navGroupsForRole(user.role)` から解決して props で渡す。
 *
 * レイアウト（デスクトップ=左サイドバー / モバイル=折りたたみ）は `globals.css` の
 * `.admin-*` クラス + メディアクエリで制御する。`data-open` でモバイル時の開閉を切り替える。
 */
export function Sidebar({ groups }: { groups: readonly NavGroup[] }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  // 最長一致のみを active にする（親 /app/school が子 /app/school/members で誤点灯するのを防ぐ）。
  // グループをまたいで平坦化したリストで判定する。
  const items = groups.flatMap((g) => g.items);
  const activeHref = activeNavHref(items, pathname);
  // 項目が 1 つ以下（teacher = エディタのみ）はハンバーガー不要。nav を常時表示するため
  // data-open を強制 "true" にして、モバイルでも畳まず見える状態にする。
  const single = items.length <= 1;

  return (
    <div className="admin-sidebar-wrap">
      {!single && (
        <button
          type="button"
          className="admin-hamburger"
          aria-expanded={open}
          aria-controls="admin-nav"
          onClick={() => setOpen((v) => !v)}
        >
          ☰ メニュー
        </button>
      )}
      <nav
        id="admin-nav"
        className="admin-nav"
        data-open={single || open ? "true" : "false"}
        aria-label="メインナビゲーション"
      >
        {groups.map((group) =>
          group.label ? (
            <NavSection
              key={group.label}
              group={group}
              activeHref={activeHref}
              onNavigate={() => setOpen(false)}
            />
          ) : (
            // 見出しなしグループ（パスワード変更 / school_admin・teacher）はフラット表示。
            // キーは先頭項目の href（グループ内で安定・一意）を使う（配列 index は使わない）。
            <NavList
              key={group.items[0]?.href ?? "flat"}
              items={group.items}
              activeHref={activeHref}
              onNavigate={() => setOpen(false)}
            />
          ),
        )}
      </nav>
    </div>
  );
}

/** 折りたたみ見出し付きグループ（配信運用 / ログ・監査）。 */
function NavSection({
  group,
  activeHref,
  onNavigate,
}: {
  group: NavGroup;
  activeHref: string;
  onNavigate: () => void;
}) {
  // active な項目を含むグループは（既定折りたたみでも）開いて見せる。それ以外は defaultCollapsed に従う。
  const containsActive = group.items.some((it) => it.href === activeHref);
  const [expanded, setExpanded] = useState(!group.defaultCollapsed || containsActive);

  return (
    <div className="admin-nav-group">
      <button
        type="button"
        className="admin-nav-group-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        <span>{group.label}</span>
        <span aria-hidden className="admin-nav-group-caret">
          {expanded ? "▾" : "▸"}
        </span>
      </button>
      {expanded && <NavList items={group.items} activeHref={activeHref} onNavigate={onNavigate} />}
    </div>
  );
}

/** nav 項目の <ul>（グループ内・フラット共通）。 */
function NavList({
  items,
  activeHref,
  onNavigate,
}: {
  items: readonly NavItem[];
  activeHref: string;
  onNavigate: () => void;
}) {
  return (
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
              onClick={onNavigate}
            >
              {item.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
