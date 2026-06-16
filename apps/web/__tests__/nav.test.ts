import type { TenantRole } from "@kimiterrace/db";
import { describe, expect, it } from "vitest";
import {
  ADMIN_ROLES,
  activeNavHref,
  homePathForRole,
  isAdminRole,
  navGroupsForRole,
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
    expect(items.map((i) => i.href)).toEqual(["/app/editor"]);
  });

  it("school_admin は学校管理 + エディタ + パスワード変更 の 3 つ (ADR-040 で contents 系統が休眠ゆえ 音声/チャット入力・コンテンツ・掲示物 Q&A を nav から撤去。機能/認可は残置で URL 直打ち可)。教職員管理は教員アカウント概念の撤去で廃止、監視系 (ダッシュボード/月次レポート/センサー管理) は校務DX原則で運営専用に撤去", () => {
    const hrefs = navItemsForRole("school_admin").map((i) => i.href);
    expect(hrefs).toEqual(["/app/school", "/app/editor", "/app/account/password"]);
    // ADR-040 (#903/#904) で curated contents 系統が休眠 → 3 導線を school_admin nav から撤去。
    // 再追加防止の回帰 (死リンク誤認で戻さない)。route/認可は残置で URL 直打ち可。
    expect(hrefs).not.toContain("/app/teacher-input");
    expect(hrefs).not.toContain("/app/contents");
    expect(hrefs).not.toContain("/app/chat");
    // 監視系は学校側から撤去 (運営 = system_admin 専用)。
    expect(hrefs).not.toContain("/app/dashboard");
    expect(hrefs).not.toContain("/app/reports");
    expect(hrefs).not.toContain("/app/sensors");
  });

  it("掲示物 Q&A (/app/chat) はどの role の nav にも出さない (ADR-040 で contents 系統休眠 + staff は classId 非バインドで grounding 不可ゆえ school_admin からも撤去・2026-06-14。機能・認可 PUBLISHER_ROLES は残置・URL 直打ち可)", () => {
    // /app/chat も /api/teacher/chat も requireRole(PUBLISHER_ROLES) で system_admin を 403 にする
    // ため、nav からも system_admin には出さない。生徒は /student の StudentChat (別経路) を使う。
    // school_admin/teacher は機能として使えるが nav 導線は撤去 (school_admin=ADR-040、teacher=2026-06-11)。
    expect(navItemsForRole("system_admin").map((i) => i.href)).not.toContain("/app/chat");
    expect(navItemsForRole("school_admin").map((i) => i.href)).not.toContain("/app/chat");
    expect(navItemsForRole("teacher").map((i) => i.href)).not.toContain("/app/chat");
  });

  it("教職員管理 (/app/school/members) はどの role の nav にも出さない (教員アカウント概念の撤去・2026-06-10)", () => {
    // 教員は学校共通パスワード（ADR-032・系統A）のみでログインし個別アカウントを持たない。school_admin の
    // 自校教職員管理面（個別教員の発行/無効化/設定リンク再発行）はページごと撤去したため、nav にも出さない
    // （再追加防止の回帰、[[project_remove_individual_teacher_accounts]]）。
    for (const role of ["school_admin", "teacher", "system_admin"] as const) {
      expect(navItemsForRole(role).map((i) => i.href)).not.toContain("/app/school/members");
    }
  });

  it("音声/チャット入力 (/app/teacher-input) はどの role の nav にも出さない (ADR-040 で contents 系統休眠ゆえ school_admin からも撤去・2026-06-14。機能・認可 TEACHER_INPUT_STAFF_ROLES は残置・URL 直打ち可)", () => {
    // /app/teacher-input は requireRole(TEACHER_INPUT_STAFF_ROLES=teacher/school_admin) で
    // system_admin を 403 にするため、nav からも system_admin には出さない。
    // school_admin/teacher は機能として使えるが nav 導線は撤去 (school_admin=ADR-040、teacher=2026-06-11)。
    expect(navItemsForRole("system_admin").map((i) => i.href)).not.toContain("/app/teacher-input");
    expect(navItemsForRole("school_admin").map((i) => i.href)).not.toContain("/app/teacher-input");
    expect(navItemsForRole("teacher").map((i) => i.href)).not.toContain("/app/teacher-input");
  });

  it("コンテンツ (/app/contents) はどの role の nav にも出さない (ADR-040 で contents 系統休眠ゆえ school_admin からも撤去・2026-06-14。機能・認可 PUBLISHER_ROLES は残置・URL 直打ち可)", () => {
    // /app/contents は requireRole(PUBLISHER_ROLES) で system_admin を 403 にするため、
    // nav からも system_admin には出さない (死リンク防止)。
    // school_admin/teacher は機能として使えるが nav 導線は撤去 (school_admin=ADR-040、teacher=2026-06-11)。
    expect(navItemsForRole("system_admin").map((i) => i.href)).not.toContain("/app/contents");
    expect(navItemsForRole("school_admin").map((i) => i.href)).not.toContain("/app/contents");
    expect(navItemsForRole("teacher").map((i) => i.href)).not.toContain("/app/contents");
  });

  it("ダッシュボード (/app/dashboard) は誰の nav にも出さない (校務DX原則で運営専用に締め、school-side ルートは撤去。運営は /ops/dashboard を使う)", () => {
    // 自校ビュー /app/dashboard は requireRole(SYSTEM_ADMIN_ROLES) に締めたため、school-side ロールの
    // nav からは撤去。system_admin は自校 /app/dashboard ではなく全校版 /ops/dashboard を使う。
    expect(navItemsForRole("school_admin").map((i) => i.href)).not.toContain("/app/dashboard");
    expect(navItemsForRole("teacher").map((i) => i.href)).not.toContain("/app/dashboard");
    expect(navItemsForRole("system_admin").map((i) => i.href)).not.toContain("/app/dashboard");
  });

  it("月次レポート (/app/reports) は誰の nav にも出さない (校務DX原則で運営専用に締め、school-side ルートは撤去。運営は /ops/reports を使う)", () => {
    // 自校ビュー /app/reports は requireRole(SYSTEM_ADMIN_ROLES) に締めたため、school-side ロールの nav
    // からは撤去。system_admin は自校 /app/reports ではなく全校版 /ops/reports を使う。
    expect(navItemsForRole("school_admin").map((i) => i.href)).not.toContain("/app/reports");
    expect(navItemsForRole("teacher").map((i) => i.href)).not.toContain("/app/reports");
    expect(navItemsForRole("system_admin").map((i) => i.href)).not.toContain("/app/reports");
  });

  it("system_admin は学校一覧 + 教職員管理 + 広告主 + 全校ダッシュボード + 全校センサー + モニタ設定 + 月次レポート + フィードバック + イベントログ + 監査ログ + AIチャット + 公開履歴 + 学校設定 + TVコマンド + TVダウンタイム + パスワード変更（自校エディタは出さない、メンバーシップ・ビューアは商流SoR一元化 Phase1 で撤去、MFA は意図的に nav 撤去）", () => {
    const hrefs = navItemsForRole("system_admin").map((i) => i.href);
    // 2026-06-16: 目的別 5 グループ化に伴いフラット順を再編（学校・ユーザー → 配信・分析 → モニタ・端末
    // → ログ・監査 → アカウント）。全 16 href の集合は不変（順序のみ変更）。
    expect(hrefs).toEqual([
      "/ops/schools",
      "/ops/users",
      "/ops/school-configs",
      "/ops/dashboard",
      "/ops/reports",
      "/ops/advertisers",
      "/ops/publishes",
      "/ops/tv-devices",
      "/ops/sensors",
      "/ops/tv-commands",
      "/ops/tv-downtime",
      "/ops/audit",
      "/ops/events",
      "/ops/ai-chat",
      "/ops/feedback",
      "/app/account/password",
    ]);
    expect(hrefs).not.toContain("/app/editor");
    // 商流SoR一元化 Phase1 (2026-06-13): メンバーシップ・ビューアは nav から撤去 (テーブル/RLS は温存)。
    expect(hrefs).not.toContain("/ops/memberships");
  });

  it("パスワード変更 (/app/account/password) は個人 email/password アカウント (system_admin/school_admin) のみ。teacher (学校共通PW・ADR-032) には出さない (死リンク防止 / PASSWORD_CHANGE_ROLES と整合)", () => {
    expect(navItemsForRole("system_admin").map((i) => i.href)).toContain("/app/account/password");
    expect(navItemsForRole("school_admin").map((i) => i.href)).toContain("/app/account/password");
    expect(navItemsForRole("teacher").map((i) => i.href)).not.toContain("/app/account/password");
  });

  it("センサー管理 (/app/sensors) は誰の nav にも出さない (校務DX原則で運営専用に締め、school-side ルートは撤去。運営は /ops/sensors を使う)", () => {
    // 自校ビュー /app/sensors は requireRole(SYSTEM_ADMIN_ROLES) に締めたため、school-side ロールの nav
    // からは撤去。system_admin は自校 /app/sensors ではなく全校版 /ops/sensors を使う。
    expect(navItemsForRole("school_admin").map((i) => i.href)).not.toContain("/app/sensors");
    expect(navItemsForRole("teacher").map((i) => i.href)).not.toContain("/app/sensors");
    expect(navItemsForRole("system_admin").map((i) => i.href)).not.toContain("/app/sensors");
  });

  it("モニタ設定 (/ops/tv-devices) は system_admin 専用 (F15 TV端末リモート管理、運営専用 nav・配線漏れ修正)", () => {
    // F15 のページ群 (一覧/編集/履歴/新規登録) は実装済だが nav 配線が漏れていた (広告主 #46 と同型)。
    // 校務DX原則でセンサー管理と同じく運営 (system_admin) 専用に出す (school_admin/teacher の nav には出さない)。
    // 編集自体は TV_CONFIG_EDIT_ROLES(school_admin/system_admin) が URL 直打ちで可能だが、nav 導線は運営に集約。
    expect(navItemsForRole("system_admin").map((i) => i.href)).toContain("/ops/tv-devices");
    expect(navItemsForRole("school_admin").map((i) => i.href)).not.toContain("/ops/tv-devices");
    expect(navItemsForRole("teacher").map((i) => i.href)).not.toContain("/ops/tv-devices");
  });

  it("センサー管理（全校） (/ops/sensors) は system_admin 専用 (F13 全校横断、§43 で /app/sensors を統合)", () => {
    // /ops/sensors は requireRole(SYSTEM_ADMIN_ROLES) で publisher を 403 にするため、
    // nav からも publisher には出さない (死リンク防止)。自校重複 /app/sensors は §43 で撤去し本ルートへ統合。
    expect(navItemsForRole("system_admin").map((i) => i.href)).toContain("/ops/sensors");
    expect(navItemsForRole("school_admin").map((i) => i.href)).not.toContain("/ops/sensors");
    expect(navItemsForRole("teacher").map((i) => i.href)).not.toContain("/ops/sensors");
  });

  it("教職員管理 (/ops/users) は system_admin 専用 (F11 全校横断・school_admin 管理用)", () => {
    // /ops/users は requireRole(SYSTEM_ADMIN_ROLES) で publisher を 403 にするため、
    // nav からも publisher には出さない (死リンク防止)。自校の個別教員管理面 (/app/school/members) は
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

  it("全校ダッシュボード (/ops/dashboard) は system_admin 専用 (F08 第4スライス cross-tenant、§43 で /app/dashboard を撤去)", () => {
    // cross-tenant の横断ビューは requireRole(SYSTEM_ADMIN_ROLES) で publisher を 403 にするため、
    // nav からも publisher には出さない (死リンク防止)。自校重複 /app/dashboard は §43 で撤去済み。
    expect(navItemsForRole("system_admin").map((i) => i.href)).toContain("/ops/dashboard");
    expect(navItemsForRole("school_admin").map((i) => i.href)).not.toContain("/ops/dashboard");
    expect(navItemsForRole("teacher").map((i) => i.href)).not.toContain("/ops/dashboard");
  });

  it("二要素認証 (/app/account/mfa) は誰の nav にも出さない (2026-06-07 ユーザー判断: MFA 現状非運用ゆえ UI 入口を撤去・機能は残置)", () => {
    // ⚠️ 意図的な撤去。enrollment ページ / Server Action / 強制ゲート / policy は残置しており、MFA 運用
    // 開始時に nav 3 項目を再追加すれば復帰する。「配線漏れ」と誤認して再追加しないこと (nav.ts の注記参照)。
    for (const role of ["system_admin", "school_admin", "teacher"] as const) {
      expect(navItemsForRole(role).map((i) => i.href)).not.toContain("/app/account/mfa");
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

describe("navGroupsForRole (グループ化・2026-06-16 ユーザー要望)", () => {
  it("system_admin は目的別 5 グループ（学校・ユーザー / 配信・分析 / モニタ・端末 / ログ・監査 / アカウント）", () => {
    const groups = navGroupsForRole("system_admin");
    expect(groups.map((g) => g.title)).toEqual([
      "学校・ユーザー",
      "配信・分析",
      "モニタ・端末",
      "ログ・監査",
      "アカウント",
    ]);
  });

  it("どのロールもグループ連結が navItemsForRole と一致する（順序の単一ソース）", () => {
    for (const role of TENANT_ROLES) {
      const flattened = navGroupsForRole(role).flatMap((g) => g.items);
      expect(flattened).toEqual(navItemsForRole(role));
    }
  });

  it("school_admin / teacher は見出し無しの 1 グループ（短いナビは従来どおりフラット表示）", () => {
    for (const role of ["school_admin", "teacher"] as const) {
      const groups = navGroupsForRole(role);
      expect(groups).toHaveLength(1);
      expect(groups[0]?.title).toBe("");
    }
  });

  it("管理エリア対象外ロール (student/guardian) は空配列（グループも出さない）", () => {
    expect(navGroupsForRole("student")).toEqual([]);
    expect(navGroupsForRole("guardian")).toEqual([]);
  });
});

describe("homePathForRole", () => {
  it("各管理ロールはそれぞれのホームへ", () => {
    expect(homePathForRole("system_admin")).toBe("/ops/schools");
    expect(homePathForRole("school_admin")).toBe("/app/school");
    expect(homePathForRole("teacher")).toBe("/app/editor");
  });

  it("管理エリア対象外ロールはサイネージ (/) に倒す", () => {
    expect(homePathForRole("student")).toBe("/");
    expect(homePathForRole("guardian")).toBe("/");
  });
});

describe("activeNavHref (最長一致)", () => {
  const schoolAdmin = navItemsForRole("school_admin");

  it("親ページ /app/school では学校管理が active", () => {
    expect(activeNavHref(schoolAdmin, "/app/school")).toBe("/app/school");
  });

  it("配下ページ /app/editor/123 はエディタ (親 href) を active にする", () => {
    expect(activeNavHref(schoolAdmin, "/app/editor/123")).toBe("/app/editor");
  });

  it("どの項目にも一致しないパスは空文字（どれも active にしない）", () => {
    expect(activeNavHref(schoolAdmin, "/admin/unknown")).toBe("");
    expect(activeNavHref([], "/app/school")).toBe("");
  });

  it("system_admin: /ops/schools/new は学校一覧を active（最長一致で 1 つだけ）", () => {
    const sysAdmin = navItemsForRole("system_admin");
    const active = activeNavHref(sysAdmin, "/ops/schools/new");
    expect(active).toBe("/ops/schools");
    // 他項目（教職員管理 /ops/users 等）は active にならない。
    expect(active).not.toBe("/ops/users");
  });
});
