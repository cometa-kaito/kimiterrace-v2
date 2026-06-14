import type { TenantRole } from "@kimiterrace/db";
import { describe, expect, it } from "vitest";
import {
  ADMIN_ROLES,
  activeNavHref,
  homePathForRole,
  isAdminRole,
  navItemsForRole,
} from "../lib/nav";

/**
 * role 別 navigation の純粋ロジック検証 (#48-C)。node 環境で網羅できるよう副作用を持たない。
 */

const TENANT_ROLES: TenantRole[] = [
  "system_admin",
  "school_admin",
  "teacher",
  "student",
  "guardian",
];

describe("isAdminRole / ADMIN_ROLES", () => {
  it("管理エリア対象は system_admin / school_admin / teacher の 3 つ", () => {
    expect([...ADMIN_ROLES]).toEqual(["system_admin", "school_admin", "teacher"]);
  });

  it("生徒・保護者は管理エリア対象外", () => {
    expect(isAdminRole("student")).toBe(false);
    expect(isAdminRole("guardian")).toBe(false);
  });

  it("管理ロールは true", () => {
    for (const r of ADMIN_ROLES) {
      expect(isAdminRole(r)).toBe(true);
    }
  });
});

describe("navItemsForRole", () => {
  it("teacher はエディタのみ (2026-06-11 ユーザー判断: 教員 UX をエディタ 1 枚に集約。音声/チャット入力・コンテンツ・掲示物 Q&A はサイネージに出ない生徒 Q&A ボットの裏方ゆえ nav から撤去・機能/認可は残置で URL 直打ち可。監視系は校務DX原則で運営専用に撤去、MFA は意図的に nav から撤去)", () => {
    const items = navItemsForRole("teacher");
    expect(items.map((i) => i.href)).toEqual(["/admin/editor"]);
  });

  it("school_admin は学校管理 + エディタ + 音声/チャット入力 + コンテンツ + 掲示物 Q&A。教職員管理は教員アカウント概念の撤去で廃止、監視系 (ダッシュボード/月次レポート/センサー管理) は校務DX原則で運営専用に撤去", () => {
    const hrefs = navItemsForRole("school_admin").map((i) => i.href);
    expect(hrefs).toContain("/admin/school");
    expect(hrefs).toContain("/admin/editor");
    expect(hrefs).toContain("/admin/teacher-input");
    expect(hrefs).toContain("/admin/contents");
    expect(hrefs).toContain("/admin/chat");
    // 監視系は学校側から撤去 (運営 = system_admin 専用)。
    expect(hrefs).not.toContain("/admin/dashboard");
    expect(hrefs).not.toContain("/admin/reports");
    expect(hrefs).not.toContain("/admin/sensors");
  });

  it("掲示物 Q&A (/admin/chat) は school_admin のみ nav に出す。system_admin は nav 非表示 (F06 #370、死リンク防止)。teacher は 2026-06-11 判断で nav から撤去 (機能・認可は残置・URL 直打ち可)", () => {
    // /admin/chat も /api/teacher/chat も requireRole(PUBLISHER_ROLES) で system_admin を 403 にする
    // ため、nav からも system_admin には出さない。生徒は /student の StudentChat (別経路) を使う。
    // teacher は機能として使えるが nav 導線は「エディタのみ」方針で撤去 (2026-06-11)。
    expect(navItemsForRole("system_admin").map((i) => i.href)).not.toContain("/admin/chat");
    expect(navItemsForRole("school_admin").map((i) => i.href)).toContain("/admin/chat");
    expect(navItemsForRole("teacher").map((i) => i.href)).not.toContain("/admin/chat");
  });

  it("教職員管理 (/admin/school/members) はどの role の nav にも出さない (教員アカウント概念の撤去・2026-06-10)", () => {
    // 教員は学校共通パスワード（ADR-032・系統A）のみでログインし個別アカウントを持たない。school_admin の
    // 自校教職員管理面（個別教員の発行/無効化/設定リンク再発行）はページごと撤去したため、nav にも出さない
    // （再追加防止の回帰、[[project_remove_individual_teacher_accounts]]）。
    for (const role of ["school_admin", "teacher", "system_admin"] as const) {
      expect(navItemsForRole(role).map((i) => i.href)).not.toContain("/admin/school/members");
    }
  });

  it("音声/チャット入力 (/admin/teacher-input) は school_admin のみ nav に出す。system_admin は nav 非表示 (TEACHER_INPUT_STAFF_ROLES と整合・死リンク防止)。teacher は 2026-06-11 判断で nav から撤去 (機能・認可は残置・URL 直打ち可)", () => {
    // /admin/teacher-input は requireRole(TEACHER_INPUT_STAFF_ROLES=teacher/school_admin) で
    // system_admin を 403 にするため、nav からも system_admin には出さない。
    // teacher は機能として使えるが nav 導線は「エディタのみ」方針で撤去 (2026-06-11)。
    expect(navItemsForRole("system_admin").map((i) => i.href)).not.toContain(
      "/admin/teacher-input",
    );
    expect(navItemsForRole("school_admin").map((i) => i.href)).toContain("/admin/teacher-input");
    expect(navItemsForRole("teacher").map((i) => i.href)).not.toContain("/admin/teacher-input");
  });

  it("コンテンツ (/admin/contents) は school_admin のみ nav に出す。system_admin は nav 非表示 (#166 と整合・死リンク防止)。teacher は 2026-06-11 判断で nav から撤去 (機能・認可は残置・URL 直打ち可)", () => {
    // /admin/contents は requireRole(PUBLISHER_ROLES) で system_admin を 403 にするため、
    // nav からも system_admin には出さない (死リンク防止)。
    // teacher は機能として使えるが nav 導線は「エディタのみ」方針で撤去 (2026-06-11)。
    expect(navItemsForRole("system_admin").map((i) => i.href)).not.toContain("/admin/contents");
    expect(navItemsForRole("school_admin").map((i) => i.href)).toContain("/admin/contents");
    expect(navItemsForRole("teacher").map((i) => i.href)).not.toContain("/admin/contents");
  });

  it("ダッシュボード (/admin/dashboard) は誰の nav にも出さない (校務DX原則で運営専用に締め、school-side ルートは撤去。運営は /ops/dashboard を使う)", () => {
    // 自校ビュー /admin/dashboard は requireRole(SYSTEM_ADMIN_ROLES) に締めたため、school-side ロールの
    // nav からは撤去。system_admin は自校 /admin/dashboard ではなく全校版 /ops/dashboard を使う。
    expect(navItemsForRole("school_admin").map((i) => i.href)).not.toContain("/admin/dashboard");
    expect(navItemsForRole("teacher").map((i) => i.href)).not.toContain("/admin/dashboard");
    expect(navItemsForRole("system_admin").map((i) => i.href)).not.toContain("/admin/dashboard");
  });

  it("月次レポート (/admin/reports) は誰の nav にも出さない (校務DX原則で運営専用に締め、school-side ルートは撤去。運営は /ops/reports を使う)", () => {
    // 自校ビュー /admin/reports は requireRole(SYSTEM_ADMIN_ROLES) に締めたため、school-side ロールの nav
    // からは撤去。system_admin は自校 /admin/reports ではなく全校版 /ops/reports を使う。
    expect(navItemsForRole("school_admin").map((i) => i.href)).not.toContain("/admin/reports");
    expect(navItemsForRole("teacher").map((i) => i.href)).not.toContain("/admin/reports");
    expect(navItemsForRole("system_admin").map((i) => i.href)).not.toContain("/admin/reports");
  });

  it("system_admin は学校一覧 + 教職員管理 + 広告主 + 全校ダッシュボード + 全校センサー + モニタ設定 + 月次レポート + フィードバック + イベントログ + 監査ログ + AIチャット + 公開履歴 + 学校設定 + TVコマンド + TVダウンタイム + パスワード変更（自校エディタは出さない、メンバーシップ・ビューアは商流SoR一元化 Phase1 で撤去、MFA は意図的に nav 撤去）", () => {
    const hrefs = navItemsForRole("system_admin").map((i) => i.href);
    expect(hrefs).toEqual([
      "/ops/schools",
      "/ops/users",
      "/ops/advertisers",
      "/ops/dashboard",
      "/ops/sensors",
      "/admin/tv-devices",
      "/ops/reports",
      "/ops/feedback",
      "/ops/events",
      "/ops/audit",
      "/ops/ai-chat",
      "/ops/publishes",
      "/ops/school-configs",
      "/ops/tv-commands",
      "/ops/tv-downtime",
      "/admin/account/password",
    ]);
    expect(hrefs).not.toContain("/admin/editor");
    // 商流SoR一元化 Phase1 (2026-06-13): メンバーシップ・ビューアは nav から撤去 (テーブル/RLS は温存)。
    expect(hrefs).not.toContain("/ops/memberships");
  });

  it("パスワード変更 (/admin/account/password) は個人 email/password アカウント (system_admin/school_admin) のみ。teacher (学校共通PW・ADR-032) には出さない (死リンク防止 / PASSWORD_CHANGE_ROLES と整合)", () => {
    expect(navItemsForRole("system_admin").map((i) => i.href)).toContain("/admin/account/password");
    expect(navItemsForRole("school_admin").map((i) => i.href)).toContain("/admin/account/password");
    expect(navItemsForRole("teacher").map((i) => i.href)).not.toContain("/admin/account/password");
  });

  it("センサー管理 (/admin/sensors) は誰の nav にも出さない (校務DX原則で運営専用に締め、school-side ルートは撤去。運営は /ops/sensors を使う)", () => {
    // 自校ビュー /admin/sensors は requireRole(SYSTEM_ADMIN_ROLES) に締めたため、school-side ロールの nav
    // からは撤去。system_admin は自校 /admin/sensors ではなく全校版 /ops/sensors を使う。
    expect(navItemsForRole("school_admin").map((i) => i.href)).not.toContain("/admin/sensors");
    expect(navItemsForRole("teacher").map((i) => i.href)).not.toContain("/admin/sensors");
    expect(navItemsForRole("system_admin").map((i) => i.href)).not.toContain("/admin/sensors");
  });

  it("モニタ設定 (/admin/tv-devices) は system_admin 専用 (F15 TV端末リモート管理、運営専用 nav・配線漏れ修正)", () => {
    // F15 のページ群 (一覧/編集/履歴/新規登録) は実装済だが nav 配線が漏れていた (広告主 #46 と同型)。
    // 校務DX原則でセンサー管理と同じく運営 (system_admin) 専用に出す (school_admin/teacher の nav には出さない)。
    // 編集自体は TV_CONFIG_EDIT_ROLES(school_admin/system_admin) が URL 直打ちで可能だが、nav 導線は運営に集約。
    expect(navItemsForRole("system_admin").map((i) => i.href)).toContain("/admin/tv-devices");
    expect(navItemsForRole("school_admin").map((i) => i.href)).not.toContain("/admin/tv-devices");
    expect(navItemsForRole("teacher").map((i) => i.href)).not.toContain("/admin/tv-devices");
  });

  it("センサー管理（全校） (/ops/sensors) は system_admin 専用 (F13 全校横断、自校 /admin/sensors とは別ルート)", () => {
    // /ops/sensors は requireRole(SYSTEM_ADMIN_ROLES) で publisher を 403 にするため、
    // nav からも publisher には出さない (死リンク防止)。自校ビュー /admin/sensors は別ルートで存続。
    expect(navItemsForRole("system_admin").map((i) => i.href)).toContain("/ops/sensors");
    expect(navItemsForRole("school_admin").map((i) => i.href)).not.toContain("/ops/sensors");
    expect(navItemsForRole("teacher").map((i) => i.href)).not.toContain("/ops/sensors");
  });

  it("教職員管理 (/ops/users) は system_admin 専用 (F11 全校横断・school_admin 管理用)", () => {
    // /ops/users は requireRole(SYSTEM_ADMIN_ROLES) で publisher を 403 にするため、
    // nav からも publisher には出さない (死リンク防止)。自校の個別教員管理面 (/admin/school/members) は
    // 教員アカウント概念の撤去で廃止済（[[project_remove_individual_teacher_accounts]]）。
    expect(navItemsForRole("system_admin").map((i) => i.href)).toContain("/ops/users");
    expect(navItemsForRole("school_admin").map((i) => i.href)).not.toContain("/ops/users");
    expect(navItemsForRole("teacher").map((i) => i.href)).not.toContain("/ops/users");
  });

  it("広告主 (/ops/advertisers) は system_admin 専用 (F10 #46 CRM、cross-tenant、収益中核)", () => {
    // 広告主マスタ/契約/コミュニケーションは requireRole(SYSTEM_ADMIN_ROLES) で publisher を 403 にする。
    // 実装・テスト済なのに nav 配線が漏れて URL 直打ちでしか到達できなかったため導線を追加 (死リンクなし)。
    expect(navItemsForRole("system_admin").map((i) => i.href)).toContain("/ops/advertisers");
    expect(navItemsForRole("school_admin").map((i) => i.href)).not.toContain("/ops/advertisers");
    expect(navItemsForRole("teacher").map((i) => i.href)).not.toContain("/ops/advertisers");
  });

  it("全校ダッシュボード (/ops/dashboard) は system_admin 専用 (F08 第4スライス cross-tenant、自校 /admin/dashboard とは別ルート)", () => {
    // cross-tenant の横断ビューは requireRole(SYSTEM_ADMIN_ROLES) で publisher を 403 にするため、
    // nav からも publisher には出さない (死リンク防止)。自校ビュー /admin/dashboard は別ルートで存続。
    expect(navItemsForRole("system_admin").map((i) => i.href)).toContain("/ops/dashboard");
    expect(navItemsForRole("school_admin").map((i) => i.href)).not.toContain("/ops/dashboard");
    expect(navItemsForRole("teacher").map((i) => i.href)).not.toContain("/ops/dashboard");
  });

  it("二要素認証 (/admin/account/mfa) は誰の nav にも出さない (2026-06-07 ユーザー判断: MFA 現状非運用ゆえ UI 入口を撤去・機能は残置)", () => {
    // ⚠️ 意図的な撤去。enrollment ページ / Server Action / 強制ゲート / policy は残置しており、MFA 運用
    // 開始時に nav 3 項目を再追加すれば復帰する。「配線漏れ」と誤認して再追加しないこと (nav.ts の注記参照)。
    for (const role of ["system_admin", "school_admin", "teacher"] as const) {
      expect(navItemsForRole(role).map((i) => i.href)).not.toContain("/admin/account/mfa");
    }
  });

  it("管理エリア対象外ロール (student/guardian) は空配列 — UI に管理ナビを出さない", () => {
    expect(navItemsForRole("student")).toEqual([]);
    expect(navItemsForRole("guardian")).toEqual([]);
  });

  it("全ロールでラベル・href が非空 (壊れたナビ項目を作らない)", () => {
    for (const role of TENANT_ROLES) {
      for (const item of navItemsForRole(role)) {
        expect(item.label.length).toBeGreaterThan(0);
        expect(item.href.startsWith("/")).toBe(true);
      }
    }
  });
});

describe("homePathForRole", () => {
  it("各管理ロールはそれぞれのホームへ", () => {
    expect(homePathForRole("system_admin")).toBe("/ops/schools");
    expect(homePathForRole("school_admin")).toBe("/admin/school");
    expect(homePathForRole("teacher")).toBe("/admin/editor");
  });

  it("管理エリア対象外ロールはサイネージ (/) に倒す", () => {
    expect(homePathForRole("student")).toBe("/");
    expect(homePathForRole("guardian")).toBe("/");
  });
});

describe("activeNavHref (最長一致)", () => {
  const schoolAdmin = navItemsForRole("school_admin");

  it("親ページ /admin/school では学校管理が active", () => {
    expect(activeNavHref(schoolAdmin, "/admin/school")).toBe("/admin/school");
  });

  it("配下ページ /admin/editor/123 はエディタ (親 href) を active にする", () => {
    expect(activeNavHref(schoolAdmin, "/admin/editor/123")).toBe("/admin/editor");
  });

  it("どの項目にも一致しないパスは空文字（どれも active にしない）", () => {
    expect(activeNavHref(schoolAdmin, "/admin/unknown")).toBe("");
    expect(activeNavHref([], "/admin/school")).toBe("");
  });

  it("system_admin: /ops/schools/new は学校一覧を active（最長一致で 1 つだけ）", () => {
    const sysAdmin = navItemsForRole("system_admin");
    const active = activeNavHref(sysAdmin, "/ops/schools/new");
    expect(active).toBe("/ops/schools");
    // 他項目（教職員管理 /ops/users 等）は active にならない。
    expect(active).not.toBe("/ops/users");
  });
});
