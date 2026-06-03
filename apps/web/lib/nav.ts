import type { TenantRole } from "@kimiterrace/db";
import { MFA_ENROLLMENT_PATH } from "./mfa/policy";

/**
 * role 別 navigation の**純粋ロジック** (#48-C)。
 *
 * **サーバー / クライアント両用 (副作用なし)**: ここには cookie / DB / firebase-admin を
 * 一切持ち込まない。role を入力に nav 項目を返すだけの純関数群にすることで、node 環境の
 * unit テストで網羅検証できる (認可の本体は `lib/auth/guard.ts` + RLS、ここは表示の出し分け)。
 *
 * **型の単一ソース (CLAUDE.md ルール3)**: role の型は `@kimiterrace/db` の `TenantRole` を
 * import する (型のみ = ビルド時に消去)。`lib/auth/session.ts` と同じ方針で、ランタイム値を
 * Next バンドルに引き込まない。
 */

/** サイドナビ 1 項目。href は V1→V2 ルート対応表 (docs/architecture/v1-v2-mapping.md) に準拠。 */
export type NavItem = {
  /** 表示ラベル (日本語)。 */
  label: string;
  /** 遷移先パス (V2 ルート)。 */
  href: string;
};

/**
 * `/admin` 配下 (管理エリア) にアクセスできるロール。
 * 生徒 (student) / 保護者 (guardian) は管理エリア対象外 → guard で 403 (`/forbidden`)。
 */
export const ADMIN_ROLES = [
  "system_admin",
  "school_admin",
  "teacher",
] as const satisfies readonly TenantRole[];

export type AdminRole = (typeof ADMIN_ROLES)[number];

const NAV_BY_ROLE: Record<AdminRole, readonly NavItem[]> = {
  // システム管理者: 全校横断の運用 (RLS bypass ではなく system_admin policy 経由、ADR-019)。
  system_admin: [
    { label: "学校一覧", href: "/admin/system/schools" },
    // F11 (#324): 全校横断の教職員ユーザー管理 (system_admin 専用)。自校ビュー /admin/school/members
    // (school_admin 専用) とは別ルート。ロール変更/無効化の操作系の土台 (ADR-026)。
    { label: "教職員管理", href: "/admin/system/users" },
    // F08 第4スライス: 全校横断の効果ダッシュボード (system_admin 専用、cross-tenant)。自校ビューの
    // /admin/dashboard とは別ルート (そちらは PUBLISHER_ROLES 専用)。
    { label: "全校ダッシュボード", href: "/admin/system/dashboard" },
    // F13 (#391, ADR-020): 全校横断の来場検知センサー状態ビュー (system_admin 専用、cross-tenant)。
    // 自校ビュー /admin/sensors (PUBLISHER_ROLES 専用) とは別ルート。#485/#486 が後続へ defer していた
    // system_admin 横断ビューがこれ。requireRole(SYSTEM_ADMIN_ROLES) で publisher は 403 → 死リンク防止。
    { label: "センサー管理（全校）", href: "/admin/system/sensors" },
    // F09 (#430): 全校横断の月次レポート履歴 + PDF DL (system_admin 専用、cross-tenant)。自校の月次
    // サマリービュー /admin/reports (PUBLISHER_ROLES) とは別ルート。
    { label: "月次レポート", href: "/admin/system/reports" },
    { label: "フィードバック", href: "/admin/system/feedback" },
    // F11 (#47, ADR-031): 自分の二要素認証 (MFA) 登録。teacher 以上 (= 全管理ロール) 共通の
    // セルフサービス。requireRole(MFA_REQUIRED_ROLES) で全管理ロール許可 → 死リンクにならない。
    { label: "二要素認証", href: MFA_ENROLLMENT_PATH },
  ],
  // 学校管理者: 自校スコープ (school_id) の学年/クラス/学科 CRUD ハブ + コンテンツ公開 + 効果可視化。
  school_admin: [
    { label: "学校管理", href: "/admin/school" },
    // F11 第2スライス: 自校教職員のロール一覧 (school_admin 専用、自校運用)。teacher には出さない
    // (requireRole(["school_admin"]) で 403 になるため死リンク防止)。
    { label: "教職員", href: "/admin/school/members" },
    { label: "エディタ", href: "/admin/editor" },
    { label: "音声/チャット入力", href: "/admin/teacher-input" },
    { label: "コンテンツ", href: "/admin/contents" },
    { label: "ダッシュボード", href: "/admin/dashboard" },
    { label: "月次レポート", href: "/admin/reports" },
    // F13 (#391 / #486): 自校の来場検知センサーの管理/状態一覧 (school_admin スコープ、RLS tenant_isolation)。
    // PUBLISHER_ROLES (school_admin/teacher) が見られる (/admin/sensors の requireRole(PUBLISHER_ROLES)
    // と整合)。system_admin には出さない (全校横断ビューは後続スライス → 死リンク防止)。
    { label: "センサー管理", href: "/admin/sensors" },
    // F06 (#370): 教員も使える掲示物 Q&A チャット。/admin/chat も /api/teacher/chat も
    // requireRole(PUBLISHER_ROLES) で system_admin を 403 にするため死リンク防止で publisher のみ。
    { label: "掲示物 Q&A", href: "/admin/chat" },
    // F11 (#47, ADR-031): 自分の二要素認証 (MFA) 登録 (セルフサービス、teacher 以上共通)。
    { label: "二要素認証", href: MFA_ENROLLMENT_PATH },
  ],
  // 教員: スケジュール/連絡/宿題エディタ + コンテンツ公開 (F04) + 効果ダッシュボード (F08) + 月次レポート (F09)。
  // コンテンツ一覧 (/admin/contents) / ダッシュボード (/admin/dashboard) / 月次レポート (/admin/reports) は
  // PUBLISHER_ROLES=school_admin/teacher 専用 (#166 / F08 第1スライス / F09 第1スライス)。
  teacher: [
    { label: "エディタ", href: "/admin/editor" },
    { label: "音声/チャット入力", href: "/admin/teacher-input" },
    { label: "コンテンツ", href: "/admin/contents" },
    { label: "ダッシュボード", href: "/admin/dashboard" },
    { label: "月次レポート", href: "/admin/reports" },
    // F13 (#391 / #486): 来場検知センサーの管理/状態一覧 (/admin/sensors)。PUBLISHER_ROLES に teacher を
    // 含むため出す (requireRole(PUBLISHER_ROLES) で teacher は許可 → 死リンクにならない、#485 のアクセス境界を維持)。
    { label: "センサー管理", href: "/admin/sensors" },
    // F06 (#370): 教員も使える掲示物 Q&A チャット (/admin/chat → /api/teacher/chat)。teacher も
    // PUBLISHER_ROLES に含まれるため出す (requireRole(PUBLISHER_ROLES) で許可 → 死リンクにならない)。
    { label: "掲示物 Q&A", href: "/admin/chat" },
    // F11 (#47, ADR-031): 自分の二要素認証 (MFA) 登録 (セルフサービス、teacher 以上共通)。
    { label: "二要素認証", href: MFA_ENROLLMENT_PATH },
  ],
};

/** 管理エリアに入れるロールか (純粋判定、guard から利用)。 */
export function isAdminRole(role: TenantRole): role is AdminRole {
  return (ADMIN_ROLES as readonly TenantRole[]).includes(role);
}

/**
 * role に対応するサイドナビ項目を返す。管理エリア対象外ロール (student/guardian) は空配列。
 * 呼出側はこれを描画するだけ — 認可は guard + RLS が担保するので、ここで漏れても
 * 実データは出ない (deny-by-default、多層防御)。
 */
export function navItemsForRole(role: TenantRole): readonly NavItem[] {
  if (!isAdminRole(role)) {
    return [];
  }
  return NAV_BY_ROLE[role];
}

/**
 * role のログイン後ホーム (= `/admin` 着地時のリダイレクト先)。
 * V1 の `/manage` → role 別ダッシュボードへの分岐を踏襲 (v1-v2-mapping §ルート対応表)。
 * 管理エリア対象外ロールはサイネージ (`/`) に倒す (管理 UI を見せない)。
 */
export function homePathForRole(role: TenantRole): string {
  switch (role) {
    case "system_admin":
      return "/admin/system/schools";
    case "school_admin":
      return "/admin/school";
    case "teacher":
      return "/admin/editor";
    default:
      return "/";
  }
}
