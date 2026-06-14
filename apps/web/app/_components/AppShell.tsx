import type { AuthUser } from "@/lib/auth/session";
import { navItemsForRole } from "@/lib/nav";
import { ToastProvider } from "@kimiterrace/ui";
import type { ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { SignOutButton } from "./SignOutButton";

/**
 * 管理エリア共通シェル (#48-C)。ブランドヘッダ + role 別サイドナビ + メイン領域。
 * **Server Component** — 認証済み `user` を受け取り、nav を `navItemsForRole` で解決する
 * (role 判定はサーバー、クライアントには確定済みの nav 項目だけ渡す)。
 *
 * レスポンシブ: 幅の出し分け・モバイルのサイドバー折りたたみはメディアクエリが要るため
 * `globals.css` の `.admin-*` クラスで制御する（インライン style では書けない）。
 */
export function AppShell({ user, children }: { user: AuthUser; children: ReactNode }) {
  const items = navItemsForRole(user.role);

  return (
    <div style={rootStyle}>
      <header style={headerStyle}>
        {/* ブランドのワードマーク（キミテラス）。 */}
        <img src="/brand/logo-wordmark.png" alt="キミテラス" style={brandLogoStyle} />
        {/* UIUX-03 (統一入口): ここが「キミテラス配信管理」(プロダクト側コンソール) であることを
            明示する。社内 ops (商流) は portal `/admin` (Rebounder・緑) が担い、配色は跨いで分ける
            (「今どっちにいるか」を最優先・UIUX-00)。 */}
        <span style={consoleLabelStyle}>配信管理</span>
        <span style={roleBadgeStyle}>{ROLE_LABEL[user.role]}</span>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "0.75rem" }}>
          {/* 統一入口の戻り導線 (UIUX-03 A)。Rebounder 社内ポータルは運営専用のため
              system_admin にのみ表示する (学校ロールに社内ツールの存在を見せない)。
              URL は env で上書き可 (既定=本番 portal)。リンク遷移のみで fetch はしない。 */}
          {user.role === "system_admin" && (
            <a href={portalAdminUrl()} style={portalLinkStyle}>
              Rebounder 社内ポータル ↗
            </a>
          )}
          {/* 教員は学校共通アカウント（ADR-032）でログインし個別 ID を持たない。合成メール
              （t-…@teacher.kimiterrace.invalid）を画面に出さず「教員」バッジのみ表示する
              ＝「教員アカウント」という概念をユーザーに見せない（ユーザー要望 2026-06-10）。
              職員・管理者（school_admin / system_admin）は個別アカウントゆえ実メールを表示する。 */}
          {user.role !== "teacher" && user.email && (
            <span style={userEmailStyle}>{user.email}</span>
          )}
          <SignOutButton />
        </div>
      </header>
      <div className="admin-body" style={bodyStyle}>
        <Sidebar items={items} />
        <main className="admin-main" style={mainStyle}>
          {/* 配下の client コンポーネントが useToast() で成功/エラー通知を出せるようにする。
              ToastProvider は client だが server の children をそのまま透過する。 */}
          <ToastProvider>{children}</ToastProvider>
        </main>
      </div>
    </div>
  );
}

/**
 * portal (社内 ops) の admin URL。Server Component 描画時に env を読む (シークレットではなく
 * 公開 URL のため env 直読みで可・ルール5の対象外)。既定は本番 portal。
 */
function portalAdminUrl(): string {
  return process.env.PORTAL_ADMIN_URL ?? "https://kimiteras.rebounder.jp/admin";
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
  padding: "0.6rem 1.25rem",
  borderBottom: "1px solid var(--brand-border)",
  background: "#fff",
};

const brandLogoStyle: React.CSSProperties = { height: "1.7rem", width: "auto", display: "block" };

const userEmailStyle: React.CSSProperties = {
  fontSize: "0.8rem",
  color: "var(--brand-muted)",
};

const consoleLabelStyle: React.CSSProperties = {
  fontSize: "0.85rem",
  fontWeight: 700,
  color: "var(--brand-muted)",
  borderLeft: "1px solid var(--brand-border)",
  paddingLeft: "0.75rem",
};

const portalLinkStyle: React.CSSProperties = {
  fontSize: "0.8rem",
  color: "var(--brand-muted)",
  textDecoration: "none",
  border: "1px solid var(--brand-border)",
  borderRadius: "999px",
  padding: "0.15rem 0.6rem",
};

const roleBadgeStyle: React.CSSProperties = {
  fontSize: "0.78rem",
  fontWeight: 600,
  padding: "0.15rem 0.6rem",
  borderRadius: "999px",
  background: "var(--brand-bg-soft)",
  border: "1px solid var(--brand-border)",
  color: "var(--brand-muted)",
};

const bodyStyle: React.CSSProperties = { display: "flex", flex: 1 };

// padding はメディアクエリで可変にするため `.admin-main`（globals.css）側で持つ
// （インライン padding を置くとモバイルの media-query 上書きが効かなくなるため）。
const mainStyle: React.CSSProperties = { flex: 1, minWidth: 0 };
