import type { AuthUser } from "@/lib/auth/session";
import { navItemsForRole } from "@/lib/nav";
import { ToastProvider } from "@kimiterrace/ui";
import type { ReactNode } from "react";
import { AdminMenuProvider, HamburgerButton } from "./AdminMenu";
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
  // 教員はナビが「エディタ」1 項目のみ（[[remove-teacher-menu-sidebar]]、ユーザー指摘 2026-06-13）。
  // 1 項目だけのためにサイドバー（メニュー）を出すのは冗長なので撤去し、メイン（エディタ）を全幅に
  // する（校務DX原則: 先生を迷わせない・編集面を広く）。複数項目を持つ school_admin / system_admin は
  // 従来どおりサイドバーを出す（項目数で判定＝ナビが増えれば自動で再表示され、配線漏れにならない）。
  const showSidebar = items.length > 1;

  // 操作群（ロール/ポータル/メール/ログアウト）。デスクトップはヘッダ右に出し、モバイルは
  // 「全部ハンバーガーの中に畳む」（ユーザー指摘 2026-06-16）。同じ内容を 2 箇所に出し分けると
  // 配線がズレやすいので、1 つの関数で生成し variant でクラスだけ切り替える（DRY）。
  // ハンバーガー（サイドバー）を持つロールだけモバイルで畳める＝ menuFooter は showSidebar 時のみ。
  // showSidebar=false（教員＝エディタ 1 項目）はメニューが無く畳めないため、操作群はヘッダに残す
  // （教員ヘッダは logo + 教員バッジ + ログアウトのみで狭幅でも溢れない）。
  const menuFooter = showSidebar ? <HeaderActions user={user} variant="menu" /> : null;

  return (
    <div style={rootStyle}>
      {/* ヘッダ右上のハンバーガーと、その下に開く nav ドロップダウンは別 DOM 位置だが同じ開閉状態を
          共有する必要がある。両方を AdminMenuProvider で包んで状態を 1 箇所に持たせる。 */}
      <AdminMenuProvider>
        {/* admin-header--has-menu: ハンバーガーを持つロールのみ、モバイルでヘッダの操作群/バッジを
            畳む（操作群は menuFooter 経由でハンバーガー内に出る）。教員（メニュー無し）には付けない
            ＝ヘッダにログアウトが残り、メニュー外で操作不能にならない。 */}
        <header className={showSidebar ? "admin-header admin-header--has-menu" : "admin-header"}>
          {/* ブランドのワードマーク（キミテラス）。 */}
          <img src="/brand/logo-wordmark.png" alt="キミテラス" className="admin-header__logo" />
          {/* UIUX-03 (統一入口): ここが「キミテラス配信管理」(プロダクト側コンソール) であることを
              明示する。社内 ops (商流) は portal `/admin` (Rebounder・緑) が担い、配色は跨いで分ける
              (「今どっちにいるか」を最優先・UIUX-00)。狭幅ではロゴで伝わるため CSS で畳む。 */}
          <span className="admin-header__label">配信管理</span>
          <span className="admin-header__badge">{ROLE_LABEL[user.role]}</span>
          <HeaderActions user={user} variant="header" />
          {/* モバイルのみ表示（CSS）。タブ（ヘッダ）右上に置き、押すと下に nav ドロップダウンが開く。
              メニューを持つロール（showSidebar）だけ出す。 */}
          {showSidebar && <HamburgerButton />}
        </header>
        <div className="admin-body" style={bodyStyle}>
          {showSidebar ? <Sidebar items={items} menuFooter={menuFooter} /> : null}
          <main className="admin-main" style={mainStyle}>
            {/* 配下の client コンポーネントが useToast() で成功/エラー通知を出せるようにする。
                ToastProvider は client だが server の children をそのまま透過する。 */}
            <ToastProvider>{children}</ToastProvider>
          </main>
        </div>
      </AdminMenuProvider>
    </div>
  );
}

/**
 * ヘッダ右（デスクトップ, variant="header"）／ハンバーガー内（モバイル, variant="menu"）に出す
 * 操作群。表示/非表示はブレークポイントで CSS が出し分ける（`.admin-header__actions` はモバイルで
 * 畳み、`.admin-nav__footer` はデスクトップで畳む）。条件分岐（system_admin のみポータル等）を
 * 1 箇所に集約し、両 variant の内容が将来ズレないようにする。
 */
function HeaderActions({ user, variant }: { user: AuthUser; variant: "header" | "menu" }) {
  const isMenu = variant === "menu";
  return (
    <div className={isMenu ? "admin-nav__footer" : "admin-header__actions"}>
      {/* メニュー内ではロールバッジもここに畳む（ヘッダのバッジはモバイルで非表示になるため）。 */}
      {isMenu && <span className="admin-nav__role">{ROLE_LABEL[user.role]}</span>}
      {/* 統一入口の戻り導線 (UIUX-03 A)。Rebounder 社内ポータルは運営専用のため
          system_admin にのみ表示する (学校ロールに社内ツールの存在を見せない)。
          URL は env で上書き可 (既定=本番 portal)。リンク遷移のみで fetch はしない。 */}
      {user.role === "system_admin" && (
        <a
          href={portalAdminUrl()}
          className={isMenu ? "admin-nav__portal" : undefined}
          style={isMenu ? undefined : portalLinkStyle}
        >
          Rebounder 社内ポータル ↗
        </a>
      )}
      {/* 教員は学校共通アカウント（ADR-032）でログインし個別 ID を持たない。合成メール
          （t-…@teacher.kimiterrace.invalid）を画面に出さず「教員」バッジのみ表示する
          ＝「教員アカウント」という概念をユーザーに見せない（ユーザー要望 2026-06-10）。
          職員・管理者（school_admin / system_admin）は個別アカウントゆえ実メールを表示する。 */}
      {user.role !== "teacher" && user.email && (
        <span className={isMenu ? "admin-nav__email" : "admin-header__email"}>{user.email}</span>
      )}
      <SignOutButton />
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

const portalLinkStyle: React.CSSProperties = {
  fontSize: "0.8rem",
  color: "var(--brand-muted)",
  textDecoration: "none",
  border: "1px solid var(--brand-border)",
  borderRadius: "999px",
  padding: "0.15rem 0.6rem",
};

const bodyStyle: React.CSSProperties = { display: "flex", flex: 1 };

// padding はメディアクエリで可変にするため `.admin-main`（globals.css）側で持つ
// （インライン padding を置くとモバイルの media-query 上書きが効かなくなるため）。
const mainStyle: React.CSSProperties = { flex: 1, minWidth: 0 };
