import type { TenantRole } from "@kimiterrace/db";

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
    { label: "フィードバック", href: "/admin/system/feedback" },
  ],
  // 学校管理者: 自校スコープ (school_id) の学年/クラス/学科 CRUD ハブ + コンテンツ公開 + 効果可視化。
  school_admin: [
    { label: "学校管理", href: "/admin/school" },
    { label: "エディタ", href: "/admin/editor" },
    { label: "コンテンツ", href: "/admin/contents" },
    { label: "ダッシュボード", href: "/admin/dashboard" },
  ],
  // 教員: スケジュール/連絡/宿題エディタ + コンテンツ公開 (F04) + 効果ダッシュボード (F08)。
  // コンテンツ一覧 (/admin/contents) / ダッシュボード (/admin/dashboard) は
  // PUBLISHER_ROLES=school_admin/teacher 専用 (#166 / F08 第1スライス)。
  teacher: [
    { label: "エディタ", href: "/admin/editor" },
    { label: "コンテンツ", href: "/admin/contents" },
    { label: "ダッシュボード", href: "/admin/dashboard" },
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
