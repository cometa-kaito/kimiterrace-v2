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

/**
 * **MFA (二要素認証) の nav 項目は意図的に外している (2026-06-07 ユーザー判断)**。MFA は現状運用しないため
 * UI の入口 (サイドナビ) からは触れさせない。ただし**機能・コードは残置**する — enrollment ページ
 * (`/admin/account/mfa`) / client 登録・解除 / 監査 Server Action (`enrollment-actions`) / 強制ゲート
 * (`enforceMfaGate`、既定 OFF) / policy はすべて温存する。本番導入時 (`MFA_ENFORCEMENT=on`) は、各ロールに
 * `{ label: "二要素認証", href: MFA_ENROLLMENT_PATH }` を**再追加すれば復帰**できる (強制ゲートが未登録者を
 * 同ページへ誘導する経路は nav に依らず機能する)。
 *
 * ⚠️ 「nav 配線が漏れている」と誤認して再追加しないこと。広告主 nav の前例 (#46、配線漏れ) とは状況が異なり、
 * これは**意図的な撤去**。再表示は MFA 運用開始の判断とセットで行う。
 */
const NAV_BY_ROLE: Record<AdminRole, readonly NavItem[]> = {
  // システム管理者: 全校横断の運用 (RLS bypass ではなく system_admin policy 経由、ADR-019)。
  system_admin: [
    { label: "学校一覧", href: "/admin/system/schools" },
    // F11 (#324): 全校横断の教職員ユーザー管理 (system_admin 専用)。自校ビュー /admin/school/members
    // (school_admin 専用) とは別ルート。ロール変更/無効化の操作系の土台 (ADR-026)。
    { label: "教職員管理", href: "/admin/system/users" },
    // F10 (#46): 広告主 CRM (system_admin 専用、cross-tenant)。広告主マスタ/契約/コミュニケーションと
    // 月次レポートの集計対象。ページ群は requireRole(SYSTEM_ADMIN_ROLES) 済で実装・テスト済だが nav 配線
    // が漏れており URL 直打ちでしか到達できなかった (収益中核機能が UI から不可視) ため導線を追加する。
    { label: "広告主", href: "/admin/system/advertisers" },
    // F08 第4スライス: 全校横断の効果ダッシュボード (system_admin 専用、cross-tenant)。校務DX原則で
    // 自校ビュー (/admin/dashboard) も system_admin 限定に締めたため、ダッシュボードは運営専用に一本化。
    { label: "全校ダッシュボード", href: "/admin/system/dashboard" },
    // F13 (#391, ADR-020): 全校横断の来場検知センサー状態ビュー (system_admin 専用、cross-tenant)。
    // 校務DX原則で自校ビュー (/admin/sensors とその登録/編集) も system_admin 限定に締めたため、センサー
    // 管理は運営専用。requireRole(SYSTEM_ADMIN_ROLES) で publisher は 403 → 死リンク防止。
    { label: "センサー管理（全校）", href: "/admin/system/sensors" },
    // F09 (#430): 全校横断の月次レポート履歴 + PDF DL (system_admin 専用、cross-tenant)。校務DX原則で
    // 自校の月次サマリービュー (/admin/reports) も system_admin 限定に締めたため、月次レポートは運営専用。
    { label: "月次レポート", href: "/admin/system/reports" },
    { label: "フィードバック", href: "/admin/system/feedback" },
    // 二要素認証 (MFA) は意図的に nav から外す (上記 NAV_BY_ROLE の注記参照。機能は残置)。
  ],
  // 学校管理者: 自校スコープ (school_id) の学年/クラス/学科 CRUD ハブ + コンテンツ公開。
  //
  // **校務DX原則 (監視系は学校側に持たせない)**: ダッシュボード / 月次レポート / センサー管理は「自校の
  // 運営を見る」監視・閲覧系であり、先生・校長の校務を楽にする機能ではない。運営 (system_admin) 専用に
  // 集約し、学校側ロールの nav からは撤去する (UX 撤去 + 各ページ/API は requireRole(SYSTEM_ADMIN_ROLES)
  // で URL 直打ち・API 直叩きも 403)。全校横断版は system_admin の /admin/system/* に存続する。
  school_admin: [
    { label: "学校管理", href: "/admin/school" },
    // F11 第2スライス: 自校教職員のロール一覧 (school_admin 専用、自校運用)。teacher には出さない
    // (requireRole(["school_admin"]) で 403 になるため死リンク防止)。
    { label: "教職員", href: "/admin/school/members" },
    { label: "エディタ", href: "/admin/editor" },
    { label: "音声/チャット入力", href: "/admin/teacher-input" },
    { label: "コンテンツ", href: "/admin/contents" },
    // F06 (#370): 教員も使える掲示物 Q&A チャット。/admin/chat も /api/teacher/chat も
    // requireRole(PUBLISHER_ROLES) で system_admin を 403 にするため死リンク防止で publisher のみ。
    { label: "掲示物 Q&A", href: "/admin/chat" },
    // 二要素認証 (MFA) は意図的に nav から外す (NAV_BY_ROLE の注記参照。機能は残置)。
  ],
  // 教員: スケジュール/連絡/宿題エディタ + コンテンツ公開 (F04) + 掲示物 Q&A (F06)。
  //
  // **校務DX原則 (監視系は学校側に持たせない)**: ダッシュボード (F08) / 月次レポート (F09) / センサー管理
  // (F13) は「自校の運営を見る」監視・閲覧系で、先生に新たな工数を発生させない方針に反する (見る人 = 運営)。
  // 運営 (system_admin) 専用に集約し teacher の nav からは撤去する。各ページ/API も requireRole(
  // SYSTEM_ADMIN_ROLES) で URL 直打ち・API 直叩きを 403 にする (UX 撤去 + 認可第一層の二段で締める)。
  teacher: [
    { label: "エディタ", href: "/admin/editor" },
    { label: "音声/チャット入力", href: "/admin/teacher-input" },
    { label: "コンテンツ", href: "/admin/contents" },
    // F06 (#370): 教員も使える掲示物 Q&A チャット (/admin/chat → /api/teacher/chat)。teacher も
    // PUBLISHER_ROLES に含まれるため出す (requireRole(PUBLISHER_ROLES) で許可 → 死リンクにならない)。
    { label: "掲示物 Q&A", href: "/admin/chat" },
    // 二要素認証 (MFA) は意図的に nav から外す (NAV_BY_ROLE の注記参照。機能は残置)。
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

/**
 * 現在パス `pathname` に対して active 表示すべき nav 項目の href を返す（**最長一致**）。
 *
 * 候補は「完全一致」または「配下（`href + "/"` 始まり、例: /admin/editor/123）」。その中で最も具体的
 * （= href が最長）な 1 つだけを active とする。これにより、親 `/admin/school`（学校管理）が子ページ
 * `/admin/school/members`（教職員）で**同時に点灯する**バグを防ぐ（前方一致だけだと親も一致するため）。
 * 一致なしは `""`（どの項目も active にしない）。
 */
export function activeNavHref(items: readonly NavItem[], pathname: string): string {
  let best = "";
  for (const item of items) {
    const matched = pathname === item.href || pathname.startsWith(`${item.href}/`);
    if (matched && item.href.length > best.length) {
      best = item.href;
    }
  }
  return best;
}
