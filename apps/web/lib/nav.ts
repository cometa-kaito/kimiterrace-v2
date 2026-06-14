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
 * サイドナビのグループ（折りたたみ見出し単位。運営整理 Phase7 §7「ナビ最終形」）。
 * system_admin の多数の項目を「配信運用」「ログ・監査」の 2 グループに畳む。
 * `label` 未指定はグループ化なし（見出しを出さずフラット表示。例: 末尾の「パスワード変更」、
 * 項目数の少ない school_admin / teacher）。
 */
export type NavGroup = {
  /** グループ見出し（折りたたみラベル）。未指定＝見出しなしのフラット表示。 */
  label?: string;
  /** 既定で畳んでおくか（参照頻度の低いグループを圧縮）。`label` がある時のみ意味を持つ。 */
  defaultCollapsed?: boolean;
  /** グループ内の nav 項目。 */
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
 * **MFA (二要素認証) の nav 項目は意図的に外している (2026-06-07 ユーザー判断)**。MFA は現状運用しないため
 * UI の入口 (サイドナビ) からは触れさせない。ただし**機能・コードは残置**する — enrollment ページ
 * (`/app/account/mfa`) / client 登録・解除 / 監査 Server Action (`enrollment-actions`) / 強制ゲート
 * (`enforceMfaGate`、既定 OFF) / policy はすべて温存する。本番導入時 (`MFA_ENFORCEMENT=on`) は、各ロールに
 * `{ label: "二要素認証", href: MFA_ENROLLMENT_PATH }` を**再追加すれば復帰**できる (強制ゲートが未登録者を
 * 同ページへ誘導する経路は nav に依らず機能する)。
 *
 * ⚠️ 「nav 配線が漏れている」と誤認して再追加しないこと。広告主 nav の前例 (#46、配線漏れ) とは状況が異なり、
 * これは**意図的な撤去**。再表示は MFA 運用開始の判断とセットで行う。
 *
 * **ナビ最終形 (運営整理 Phase7 §7・2026-06-14 ユーザー確定)**: system_admin の運営項目を「配信運用」
 * 「ログ・監査」の 2 グループに折りたたむ。flatten 後の順序・項目は従来と不変（`navItemsForRole` の契約・
 * `activeNavHref` 判定・回帰テストを壊さない）。school_admin / teacher は項目が少ないためグループ化しない。
 */
const NAV_GROUPS_BY_ROLE: Record<AdminRole, readonly NavGroup[]> = {
  // システム管理者: 全校横断の運用 (RLS bypass ではなく system_admin policy 経由、ADR-019)。
  system_admin: [
    {
      // 配信運用: 学校・教職員・広告配信・監視（ダッシュボード/センサー/モニタ）・レポート・フィードバック。
      label: "配信運用",
      items: [
        { label: "学校一覧", href: "/ops/schools" },
        // F11 (#324): 全校横断の教職員ユーザー管理 (system_admin 専用)。自校ビュー /app/school/members
        // (school_admin 専用) とは別ルート。ロール変更/無効化の操作系の土台 (ADR-026)。
        { label: "教職員管理", href: "/ops/users" },
        // F10 (#46) → UIUX-03 PR8 (商流 UI 退役・段階1): 商流 (広告主マスタ/契約/コミュニケーション) の
        // SoR は portal に確定 (実装設計書 §26/§42.2/§43)。v2 の重複 CRM 管理面はナビから退役する。
        // ⚠ ただし「広告クリエイティブのクラス割当 (どの画面に何を出すか) = 配信」は v2 に残すため
        // (UIUX-03 C-3)、その入口である一覧ページはラベルを「広告配信割当」に改めて温存する (#46 の
        // 「収益中核機能が nav から不可視」の再発防止)。商流レコードの編集ページ群はルート温存のまま
        // 一覧バナーで portal へ誘導。物理削除は参照ゼロ実証後の別 PR (Opus/ユーザー判断)。
        { label: "広告配信割当", href: "/ops/advertisers" },
        // F08 第4スライス: 全校横断の効果ダッシュボード (system_admin 専用、cross-tenant)。§43 で自校重複
        // (/app/dashboard) を撤去し /ops/dashboard に一本化したため、ダッシュボードは運営専用。
        { label: "全校ダッシュボード", href: "/ops/dashboard" },
        // F13 (#391, ADR-020): 全校横断の来場検知センサー状態ビュー (system_admin 専用、cross-tenant)。§43 で
        // 自校重複の一覧 (/app/sensors) を撤去し、登録/編集/履歴の CRUD も /ops/sensors 配下へ統合したため、
        // センサー管理は運営専用。requireRole(SYSTEM_ADMIN_ROLES) で publisher は 403 → 死リンク防止。
        { label: "センサー管理（全校）", href: "/ops/sensors" },
        // F15 (ADR-022): TV(サイネージ)端末のリモート管理。モニタごとに signage URL / 起動スケジュール
        // (表示 ON/OFF 時刻・曜日) / センサー MAC 等を設定 (編集ページ #494) + 死活/設定版/履歴表示。ページ群は
        // 実装・テスト済 (#487/#494/#496/#497/#499/#500/#628) だが **nav 配線が漏れて URL 直打ちでしか到達でき
        // なかった** (広告主 #46 と同型の配線漏れ)。校務DX原則でセンサー管理と同じく運営 (system_admin) 専用に出す。
        { label: "モニタ設定", href: "/ops/tv-devices" },
        // F09 (#430): 全校横断の月次レポート履歴 + PDF DL (system_admin 専用、cross-tenant)。§43 で自校の
        // 月次サマリービュー (/app/reports) を撤去し /ops/reports に一本化したため、月次レポートは運営専用。
        { label: "月次レポート", href: "/ops/reports" },
        { label: "フィードバック", href: "/ops/feedback" },
      ],
    },
    {
      // ログ・監査: 全校横断の閲覧系ビューア群（events / audit / ai-chat / publishes / school-configs /
      // tv-commands / tv-downtime）。PII 近接のため「表示時マスキング + 閲覧自体の監査記録」を各ページが
      // 実装 (docs/compliance/admin-viewer-policy.md DRAFT)。参照頻度が低いため既定で折りたたむ。
      // 商流SoR一元化 Phase1 (2026-06-13): メンバーシップ・ビューア (/ops/memberships) は撤去（設計上 row が
      // 構造的に生成されず常に空）。⚠ memberships テーブル/スキーマ/RLS は温存し UI のみ削除 (§43 二段階退役)。
      label: "ログ・監査",
      defaultCollapsed: true,
      items: [
        { label: "イベント生ログ", href: "/ops/events" },
        { label: "監査ログ", href: "/ops/audit" },
        { label: "AIチャット監査", href: "/ops/ai-chat" },
        { label: "公開履歴", href: "/ops/publishes" },
        { label: "学校設定", href: "/ops/school-configs" },
        { label: "TVコマンド履歴", href: "/ops/tv-commands" },
        { label: "TVダウンタイム", href: "/ops/tv-downtime" },
      ],
    },
    {
      // 自分のパスワード変更 (個人 email/password アカウント)。グループ化せず末尾に単独表示。
      // 対象ロールは PASSWORD_CHANGE_ROLES (system_admin / school_admin) と揃える (password-policy.ts)。
      // 二要素認証 (MFA) は意図的に nav から外す (上記 NAV_GROUPS_BY_ROLE の注記参照。機能は残置)。
      items: [{ label: "パスワード変更", href: "/app/account/password" }],
    },
  ],
  // 学校管理者: 自校スコープ (school_id) の学年/クラス/学科 CRUD ハブ + エディタ。項目が少ないため
  // グループ化しない（フラット表示）。
  //
  // **校務DX原則 (監視系は学校側に持たせない)**: ダッシュボード / 月次レポート / センサー管理は「自校の
  // 運営を見る」監視・閲覧系であり、先生・校長の校務を楽にする機能ではない。運営 (system_admin) 専用に
  // 集約し、学校側ロールの nav からは撤去する (UX 撤去 + 各ページ/API は requireRole(SYSTEM_ADMIN_ROLES)
  // で URL 直打ち・API 直叩きも 403)。全校横断版は system_admin の /ops/* に存続する。
  //
  // **ADR-040 で contents 系統が休眠 → 「音声/チャット入力」(/app/teacher-input)・「コンテンツ」
  // (/app/contents)・「掲示物 Q&A」(/app/chat) を school_admin nav からも撤去 (2026-06-14)**。生徒/保護者
  // Q&A の知識源は編集 (`daily_data` 連絡/提出物) の直接注入に再ソース化され (ADR-040、#903)、curated
  // `contents` 系統 (音声/チャット入力 → teacher_inputs → contents、コンテンツ画面での公開) とその embedding
  // RAG は休眠した (embedding Job は enabled=false・未apply、#904)。よってこの 3 導線は「書いても Q&A にも
  // サイネージにも出ない」デッドエンド。掲示物 Q&A (/app/chat) も staff 向けで、M3 直接注入は生徒の classId
  // 前提のため staff (クラス非バインド) では grounding できず general_supplement のみ＝低価値。
  // teacher ブロック (下) と同じ規律で **nav 導線のみ撤去**し、route/ページ/認可 (requireRole の
  // PUBLISHER_ROLES / TEACHER_INPUT_STAFF_ROLES) は**残置** — URL 直打ちは引き続き到達可能。
  //
  // ⚠️ **意図的な撤去であり「配線漏れ」ではない (MFA / 広告主 #46 の前例と区別すること)**。死リンクと
  // 誤認して再追加しないこと。再表示は contents 系統の再活性 (ADR-040 の覆し) とセットで判断する。
  school_admin: [
    {
      items: [
        { label: "学校管理", href: "/app/school" },
        // 教員アカウント概念の撤去（2026-06-10 ユーザー判断）に伴い「教職員」(/app/school/members) を撤去。
        // 教員は学校共通パスワード（ADR-032・系統A）のみでログインし個別アカウントを持たない。教員ロールの
        // 付与/無効化/設定リンク発行という school_admin の自校教職員管理面ごと廃止した（[[project_remove_individual_teacher_accounts]]）。
        { label: "エディタ", href: "/app/editor" },
        // 自分のパスワード変更 (個人 email/password アカウント)。teacher は学校共通パスワード (ADR-032) で
        // 個人 PW を持たないため出さない (PASSWORD_CHANGE_ROLES = school_admin / system_admin と整合)。
        { label: "パスワード変更", href: "/app/account/password" },
        // 二要素認証 (MFA) は意図的に nav から外す (NAV_GROUPS_BY_ROLE の注記参照。機能は残置)。
      ],
    },
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
  // 引き続き到達できる。**ADR-040 (2026-06-14) で生徒/保護者 Q&A の知識源は編集 (`daily_data`) の直接注入に
  // 再ソース化され、curated `contents` 経路とその embedding RAG は休眠した**。これに伴い「音声/チャット入力」
  // (F02)・「コンテンツ」(F04)・「掲示物 Q&A」(F06) の 3 導線は **school_admin nav からも撤去** (上の
  // school_admin ブロック参照)。旧「コンテンツ投入を school_admin に集約 (ADR-038)」は ADR-040 で決着済 →
  // school_admin 集約は撤回。ダッシュボード (F08) / 月次レポート (F09) / センサー管理 (F13) は校務DX原則で
  // 運営 (system_admin) 専用に撤去済。MFA も意図的に nav から外す (NAV_GROUPS_BY_ROLE の注記参照。機能は残置)。
  teacher: [{ items: [{ label: "エディタ", href: "/app/editor" }] }],
};

/** 管理エリアに入れるロールか (純粋判定、guard から利用)。 */
export function isAdminRole(role: TenantRole): role is AdminRole {
  return (ADMIN_ROLES as readonly TenantRole[]).includes(role);
}

/**
 * role に対応するサイドナビ**グループ**を返す（折りたたみ表示用）。管理エリア対象外ロール
 * (student/guardian) は空配列。認可は guard + RLS が担保するので、ここで漏れても実データは出ない。
 */
export function navGroupsForRole(role: TenantRole): readonly NavGroup[] {
  if (!isAdminRole(role)) {
    return [];
  }
  return NAV_GROUPS_BY_ROLE[role];
}

/**
 * role に対応するサイドナビ項目（**フラット**）を返す。グループを順に平坦化したもので、順序・項目は
 * グループ導入前と不変（`activeNavHref` の最長一致や既存の回帰テストはこの平坦リストを前提とする）。
 * 管理エリア対象外ロール (student/guardian) は空配列。
 */
export function navItemsForRole(role: TenantRole): readonly NavItem[] {
  return navGroupsForRole(role).flatMap((g) => g.items);
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
