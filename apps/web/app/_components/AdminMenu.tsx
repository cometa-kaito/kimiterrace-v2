"use client";

import { type ReactNode, createContext, useContext, useState } from "react";

/**
 * モバイルのハンバーガー開閉状態を、**ヘッダ右上のトグルボタン**（{@link HamburgerButton}）と
 * **サイドナビのドロップダウン**（{@link Sidebar}）で共有するための薄い client コンテキスト。
 *
 * ハンバーガーをヘッダ（タブ）右上に置きつつ、開く中身（nav + 操作群）はヘッダ直下に出す——
 * という構成上、トグルとメニューは別々の DOM 位置に分かれる（ユーザー指摘 2026-06-16）。
 * 両者は同じ `open` を参照する必要があるため、AppShell（server）が header と body の両方を
 * この provider で包み、状態を 1 箇所に持たせる。server コンポーネントを子に挟んでも、
 * 末端の client コンポーネント（ボタン / Sidebar）から `useAdminMenu()` で参照できる。
 */
type AdminMenuState = { open: boolean; setOpen: (open: boolean) => void };

const AdminMenuContext = createContext<AdminMenuState | null>(null);

export function useAdminMenu(): AdminMenuState {
  const ctx = useContext(AdminMenuContext);
  if (!ctx) {
    throw new Error("useAdminMenu must be used within <AdminMenuProvider>");
  }
  return ctx;
}

export function AdminMenuProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <AdminMenuContext.Provider value={{ open, setOpen }}>{children}</AdminMenuContext.Provider>
  );
}

/**
 * ヘッダ右上のハンバーガー（☰）。**アイコンのみ**で「メニュー」の文字は出さない
 * （ユーザー指摘 2026-06-16）。文字を消すと SR から用途が分からなくなるため `aria-label` で補い、
 * `aria-controls` で開閉対象の nav（id="admin-nav"）を指す。表示はモバイルのみ（globals.css）。
 */
export function HamburgerButton() {
  const { open, setOpen } = useAdminMenu();
  return (
    <button
      type="button"
      className="admin-hamburger"
      aria-label="メニュー"
      aria-expanded={open}
      aria-controls="admin-nav"
      onClick={() => setOpen(!open)}
    >
      ☰
    </button>
  );
}
