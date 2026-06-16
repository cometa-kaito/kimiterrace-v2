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
  /**
   * 先頭アイコンのキー (Sidebar の `navIcon` が解決する依存ゼロ SVG。`app/_components/nav-icons.tsx`)。
   * 表示の装飾のみ・任意 (未指定や未知キーはアイコン無しでフォールバック)。
   */
  icon?: string;
};

/**
 * サイドナビの 1 グループ (見出し + 項目)。`title` 空文字なら Sidebar は見出しを描かない
 * (school_admin / teacher の短いナビはグループ見出し無しで従来どおりフラット表示)。
 *
 * グループ化は **表示の出し分け** であり認可とは無関係 (認可は guard + RLS、deny-by-default)。
 * フラットな項目順は {@link navItemsForRole} が各グループを連結して返す = 既存の active 判定や
 * テストの順序契約はこの連結順で保たれる。
 */
export type NavGroup = {
  /** グループ見出し (日本語)。空文字は「見出しを描かない」。 */
  title: string;
  /** このグループの nav 項目。 */
  items: readonly NavItem[];
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
 * role 別サイドナビ (#48-C) を **グループ化** して定義する単一ソース。
 *
 * **system_admin のグループ化 (2026-06-16 ユーザー要望)**: 16 項目がフラットに並んで走査しづらい
 * ため、目的別の 5 グループ (学校・ユーザー / 配信・分析 / モニタ・端末 / ログ・監査 / アカウント) に
 * 見出しを付けて整理する。フラット順は {@link navItemsForRole} がグループ連結で返す (順序の単一ソース)。
 * school_admin / teacher は項目が少ないため見出し無しの 1 グループ (見た目は従来どおり)。
 *
 * **意図的に nav から外している項目 (「配線漏れ」と誤認して再追加しないこと)** — 機能・ルート・認可は
 * いずれも残置し URL 直打ちは可能。導線のみ撤去:
 *  - **MFA (二要素認証, /app/account/mfa)**: 現状非運用ゆえ UI 入口を撤去 (2026-06-07)。enrollment /
 *    Server Action / 強制ゲート (既定 OFF) / policy は残置。運用開始時に各ロールへ再追加すれば復帰。
 *  - **音声/チャット入力 (/app/teacher-input) / コンテンツ (/app/contents) / 掲示物 Q&A (/app/chat)**:
 *    ADR-040 で curated contents 系統が休眠 (embedding RAG 停止)、生徒 Q&A の知識源は daily_data 直接注入へ
 *    再ソース化。3 導線は school_admin / teacher の nav から撤去 (2026-06-14, 2026-06-11)。認可は
 *    PUBLISHER_ROLES / TEACHER_INPUT_STAFF_ROLES で system_admin を 403。
 *  - **自校監視系 (/app/dashboard, /app/reports, /app/sensors)**: 校務DX原則で運営専用に締め、school-side
 *    ルートは撤去。system_admin は全校版 (/ops/*) を使う。
 *  - **メンバーシップ・ビューア (/ops/memberships)**: 商流SoR一元化 Phase1 で撤去 (テーブル/RLS は温存)。
 *  - **教職員管理 (/app/school/members)**: 教員アカウント概念の撤去で廃止 ([[project_remove_individual_teacher_accounts]])。
 *  - **system_admin に自校エディタ (/app/editor)**: system_admin は schoolId=null ゆえ出さない。
 */
const NAV_GROUPS_BY_ROLE: Record<AdminRole, readonly NavGroup[]> = {
  // システム管理者: 全校横断の運用 (RLS bypass ではなく system_admin policy 経由、ADR-019)。目的別 5 グループ。
  system_admin: [
    {
      title: "学校・ユーザー",
      items: [
        { label: "学校一覧", href: "/ops/schools", icon: "building" },
        // F11 (#324): 全校横断の教職員ユーザー管理 (system_admin 専用、ADR-026)。
        { label: "教職員管理", href: "/ops/users", icon: "users" },
        { label: "学校設定", href: "/ops/school-configs", icon: "settings" },
      ],
    },
    {
      title: "配信・分析",
      items: [
        // F08 (#44): 全校横断の効果ダッシュボード (cross-tenant)。自校重複 /app/dashboard は §43 で撤去。
        { label: "全校ダッシュボード", href: "/ops/dashboard", icon: "chart" },
        // F09 (#430): 全校横断の月次レポート履歴 + PDF DL (cross-tenant)。
        { label: "月次レポート", href: "/ops/reports", icon: "file" },
        // F10 (#46) → UIUX-03: 商流マスタは portal が SoR。v2 に残すのは「広告クリエイティブのクラス割当
        // (配信)」のためラベルを「広告配信割当」にして一覧を温存する。
        { label: "広告配信割当", href: "/ops/advertisers", icon: "megaphone" },
        { label: "公開履歴", href: "/ops/publishes", icon: "history" },
      ],
    },
    {
      title: "モニタ・端末",
      items: [
        // F15 (ADR-022): TV (サイネージ) 端末のリモート管理 (signage URL / 起動スケジュール / 死活)。
        { label: "モニタ設定", href: "/ops/tv-devices", icon: "tv" },
        // F13 (#391, ADR-020): 全校横断の来場検知センサー状態 (cross-tenant)。自校 /app/sensors は §43 で統合。
        { label: "センサー管理（全校）", href: "/ops/sensors", icon: "sensor" },
        { label: "TVコマンド履歴", href: "/ops/tv-commands", icon: "terminal" },
        { label: "TVダウンタイム", href: "/ops/tv-downtime", icon: "alert" },
      ],
    },
    {
      title: "ログ・監査",
      items: [
        // UIUX-03 (PR2-5): 生データ閲覧ビューア群。PII 近接のため表示時マスキング + 閲覧自体の監査記録。
        { label: "監査ログ", href: "/ops/audit", icon: "shield" },
        { label: "イベント生ログ", href: "/ops/events", icon: "list" },
        { label: "AIチャット監査", href: "/ops/ai-chat", icon: "message" },
        { label: "フィードバック", href: "/ops/feedback", icon: "feedback" },
      ],
    },
    {
      title: "アカウント",
      // 自分のパスワード変更 (個人 email/password アカウント)。PASSWORD_CHANGE_ROLES と整合。
      items: [{ label: "パスワード変更", href: "/app/account/password", icon: "key" }],
    },
  ],
  // 学校管理者: 自校スコープ (school_id)。項目が少ないため見出し無しの 1 グループ (従来の見た目を維持)。
  // 教員アカウント概念の撤去で「教職員」(/app/school/members) は廃止。監視系 (ダッシュボード/月次/センサー) は
  // 校務DX原則で運営専用に撤去。contents 系統 3 導線は ADR-040 休眠で撤去 (上のヘッダ注記参照)。
  school_admin: [
    {
      title: "",
      items: [
        { label: "学校管理", href: "/app/school", icon: "building" },
        { label: "エディタ", href: "/app/editor", icon: "edit" },
        // teacher は学校共通PW (ADR-032) で個人 PW を持たないため出さない (PASSWORD_CHANGE_ROLES と整合)。
        { label: "パスワード変更", href: "/app/account/password", icon: "key" },
      ],
    },
  ],
  // 教員: エディタ 1 枚に集約 (2026-06-11)。サイネージに出るのは daily_data のみ。contents 系統・監視系・MFA は
  // 意図的に nav から撤去 (機能・認可は残置・URL 直打ち可、上のヘッダ注記参照)。
  teacher: [{ title: "", items: [{ label: "エディタ", href: "/app/editor", icon: "edit" }] }],
};

/** 管理エリアに入れるロールか (純粋判定、guard から利用)。 */
export function isAdminRole(role: TenantRole): role is AdminRole {
  return (ADMIN_ROLES as readonly TenantRole[]).includes(role);
}

/**
 * role に対応するサイドナビの **グループ** を返す。管理エリア対象外ロール (student/guardian) は空配列。
 * Sidebar はこれを描画するだけ — 認可は guard + RLS が担保するので、ここで漏れても実データは出ない
 * (deny-by-default、多層防御)。
 */
export function navGroupsForRole(role: TenantRole): readonly NavGroup[] {
  if (!isAdminRole(role)) {
    return [];
  }
  return NAV_GROUPS_BY_ROLE[role];
}

/**
 * role に対応するサイドナビ項目を **フラット** に返す (グループを連結)。順序はグループ定義順に従う
 * = active 判定・showSidebar 判定・順序契約テストの単一ソース。管理エリア対象外ロールは空配列。
 */
export function navItemsForRole(role: TenantRole): readonly NavItem[] {
  return navGroupsForRole(role).flatMap((group) => group.items);
}

/**
 * role のログイン後ホーム (= `/admin` 着地時のリダイレクト先)。
 * V1 の `/manage` → role 別ダッシュボードへの分岐を踏襲 (v1-v2-mapping §ルート対応表)。
 * 管理エリア対象外ロールはサイネージ (`/`) に倒す (管理 UI を見せない)。
 */
export function homePathForRole(role: TenantRole): string {
  switch (role) {
    case "system_admin":
      return "/ops/schools";
    case "school_admin":
      return "/app/school";
    case "teacher":
      return "/app/editor";
    default:
      return "/";
  }
}

/**
 * 現在パス `pathname` に対して active 表示すべき nav 項目の href を返す（**最長一致**）。
 *
 * 候補は「完全一致」または「配下（`href + "/"` 始まり、例: /app/editor/123）」。その中で最も具体的
 * （= href が最長）な 1 つだけを active とする。これにより、親 `/app/school`（学校管理）が子ページ
 * `/app/school/members`（教職員）で**同時に点灯する**バグを防ぐ（前方一致だけだと親も一致するため）。
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
