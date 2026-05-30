import type { AuthUser } from "@/lib/auth/session";
import { navItemsForRole } from "@/lib/nav";
import type { ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { SignOutButton } from "./SignOutButton";

/**
 * 管理エリア共通シェル (#48-C)。ヘッダ + role 別サイドナビ + メイン領域。
 * **Server Component** — 認証済み `user` を受け取り、nav を `navItemsForRole` で解決する
 * (role 判定はサーバー、クライアントには確定済みの nav 項目だけ渡す)。
 */
export function AppShell({ user, children }: { user: AuthUser; children: ReactNode }) {
  const items = navItemsForRole(user.role);

  return (
    <div style={rootStyle}>
      <header style={headerStyle}>
        <span style={brandStyle}>キミテラス v2</span>
        <span style={roleBadgeStyle}>{ROLE_LABEL[user.role]}</span>
        <div style={{ marginLeft: "auto" }}>
          <SignOutButton />
        </div>
      </header>
      <div style={bodyStyle}>
        <Sidebar items={items} />
        <main style={mainStyle}>{children}</main>
      </div>
    </div>
  );
}

/** role の表示名 (ヘッダのバッジ用)。`TenantRole` 全網羅。 */
const ROLE_LABEL: Record<AuthUser["role"], string> = {
  system_admin: "システム管理者",
  school_admin: "学校管理者",
  teacher: "教員",
  student: "生徒",
  guardian: "保護者",
};

const rootStyle: React.CSSProperties = {
  minHeight: "100vh",
  display: "flex",
  flexDirection: "column",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
  padding: "0.75rem 1.25rem",
  borderBottom: "1px solid #e5e7eb",
  background: "#1f2937",
  color: "#fff",
};

const brandStyle: React.CSSProperties = { fontWeight: 700, fontSize: "1.05rem" };

const roleBadgeStyle: React.CSSProperties = {
  fontSize: "0.8rem",
  padding: "0.15rem 0.5rem",
  borderRadius: "999px",
  background: "rgba(255,255,255,0.15)",
};

const bodyStyle: React.CSSProperties = { display: "flex", flex: 1 };

const mainStyle: React.CSSProperties = { flex: 1, padding: "1.5rem", minWidth: 0 };
