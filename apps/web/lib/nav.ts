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
    // F10 (#46) → UIUX-03 PR8 (商流 UI 退役・段階1): 商流 (広告主マスタ/契約/コミュニケーション) の
    // SoR は portal に確定 (実装設計書 §26/§42.2/§43)。v2 の重複 CRM 管理面はナビから退役する。
    // ⚠ ただし「広告クリエイティブのクラス割当 (どの画面に何を出すか) = 配信」は v2 に残すため
    // (UIUX-03 C-3)、その入口である一覧ページはラベルを「広告配信割当」に改めて温存する (#46 の
    // 「収益中核機能が nav から不可視」の再発防止)。商流レコードの編集ページ群はルート温存のまま
    // 一覧バナーで portal へ誘導。物理削除は参照ゼロ実証後の別 PR (Opus/ユーザー判断)。
    { label: "広告配信割当", href: "/admin/system/advertisers" },
    // F08 第4スライス: 全校横断の効果ダッシュボード (system_admin 専用、cross-tenant)。校務DX原則で
    // 自校ビュー (/admin/dashboard) も system_admin 限定に締めたため、ダッシュボードは運営専用に一本化。
    { label: "全校ダッシュボード", href: "/admin/system/dashboard" },
    // F13 (#391, ADR-020): 全校横断の来場検知センサー状態ビュー (system_admin 専用、cross-tenant)。
    // 校務DX原則で自校ビュー (/admin/sensors とその登録/編集) も system_admin 限定に締めたため、センサー
    // 管理は運営専用。requireRole(SYSTEM_ADMIN_ROLES) で publisher は 403 → 死リンク防止。
    { label: "センサー管理（全校）", href: "/admin/system/sensors" },
    // F15 (ADR-022): TV(サイネージ)端末のリモート管理。モニタごとに signage URL / 起動スケジュール
    // (表示 ON/OFF 時刻・曜日) / センサー MAC 等を設定 (編集ページ #494) + 死活/設定版/履歴表示。ページ群は
    // 実装・テスト済 (#487/#494/#496/#497/#499/#500/#628) だが **nav 配線が漏れて URL 直打ちでしか到達でき
    // なかった** (広告主 #46 と同型の配線漏れ)。校務DX原則でセンサー管理と同じく運営 (system_admin) 専用に出す。
    { label: "モニタ設定", href: "/admin/tv-devices" },
    // F09 (#430): 全校横断の月次レポート履歴 + PDF DL (system_admin 専用、cross-tenant)。校務DX原則で
    // 自校の月次サマリービュー (/admin/reports) も system_admin 限定に締めたため、月次レポートは運営専用。
    { label: "月次レポート", href: "/admin/system/reports" },
    { label: "フィードバック", href: "/admin/system/feedback" },
    // UIUX-03 (PR2-4): 不足ビューア群 (system_admin 専用、cross-tenant)。events / audit_log / ai_chat の
    // 生データ閲覧。PII 近接のため「表示時マスキング + 閲覧自体の監査記録」を各ページが実装する
    // (docs/compliance/admin-viewer-policy.md DRAFT)。nav 配線は 3 ビューア分をまとめて PR4 で追加
    // (nav.ts の 3 連続編集を避ける)。
    { label: "イベント生ログ", href: "/admin/system/events" },
    { label: "監査ログ", href: "/admin/system/audit" },
    { label: "AIチャット監査", href: "/admin/system/ai-chat" },
    // UIUX-03 (PR5): 残ビューア群。公開履歴 / 学校設定 (quiet hours 等の編集) / メンバーシップ
    // (読み取り+マスクのみ) / TV コマンド・ダウンタイムの全校横断ログ。
    { label: "公開履歴", href: "/admin/system/publishes" },
    { label: "学校設定", href: "/admin/system/school-configs" },
    { label: "メンバーシップ", href: "/admin/system/memberships" },
    { label: "TVコマンド履歴", href: "/admin/system/tv-commands" },
    { label: "TVダウンタイム", href: "/admin/system/tv-downtime" },
    // 自分のパスワード変更 (個人 email/password アカウント)。ログイン後にここから再設定できる。
    // 対象ロールは PASSWORD_CHANGE_ROLES (system_admin / school_admin) と揃える (password-policy.ts)。
    { label: "パスワード変更", href: "/admin/account/password" },
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
    // 教員アカウント概念の撤去（2026-06-10 ユーザー判断）に伴い「教職員」(/admin/school/members) を撤去。
    // 教員は学校共通パスワード（ADR-032・系統A）のみでログインし個別アカウントを持たない。教員ロールの
    // 付与/無効化/設定リンク発行という school_admin の自校教職員管理面ごと廃止した（[[project_remove_individual_teacher_accounts]]）。
    { label: "エディタ", href: "/admin/editor" },
    { label: "音声/チャット入力", href: "/admin/teacher-input" },
    { label: "コンテンツ", href: "/admin/contents" },
    // F06 (#370): 教員も使える掲示物 Q&A チャット。/admin/chat も /api/teacher/chat も
    // requireRole(PUBLISHER_ROLES) で system_admin を 403 にするため死リンク防止で publisher のみ。
    { label: "掲示物 Q&A", href: "/admin/chat" },
    // 自分のパスワード変更 (個人 email/password アカウント)。teacher は学校共通パスワード (ADR-032) で
    // 個人 PW を持たないため出さない (PASSWORD_CHANGE_ROLES = school_admin / system_admin と整合)。
    { label: "パスワード変更", href: "/admin/account/password" },
    // 二要素認証 (MFA) は意図的に nav から外す (NAV_BY_ROLE の注記参照。機能は残置)。
  ],
  // 教員: スケジュール/連絡/宿題エディタ **のみ**。
  //
  // **教員 UX はエディタ 1 枚に集約する (2026-06-11 ユーザー判断)**。サイネージ (TV) に表示されるのは
  // エディタが書く `daily_data` (予定/連絡/提出物) だけ — `getSignageDisplayData` は contents/publishes を
  // 読まない。一方「音声/チャット入力」(F02)・「コンテンツ」(F04)・「掲示物 Q&A」(F06) は、音声/ファイル →
  // contents → embedding → RAG → **生徒向け Q&A チャットボットの裏方**であり、サイネージには出ない別系統。
  // よって教員が「サイネージに出す」目的では不要 → nav 導線から撤去し、先生を迷わせない (校務DX原則: 先生の
  // 工数を増やさない)。
  //
  // ⚠️ **意図的な撤去であり「配線漏れ」ではない (MFA / 広告主 #46 の前例と区別すること)**。機能・ページ・
  // 認可 (requireRole の PUBLISHER_ROLES / TEACHER_INPUT_STAFF_ROLES) は**残置**し、teacher は URL 直打ちで
  // 引き続き到達できる。生徒向け Q&A ボットとコンテンツ系統も存続し、コンテンツ投入 (ボット知識) の導線は
  // school_admin nav に残す (上の school_admin ブロック参照)。「コンテンツ投入を今後誰が担うか」は別途設計。
  // ダッシュボード (F08) / 月次レポート (F09) / センサー管理 (F13) は校務DX原則で運営 (system_admin) 専用に
  // 撤去済。MFA も意図的に nav から外す (NAV_BY_ROLE の注記参照。機能は残置)。
  teacher: [{ label: "エディタ", href: "/admin/editor" }],
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
