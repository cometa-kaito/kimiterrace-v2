import type { TenantRole } from "@kimiterrace/db";
import { describe, expect, it } from "vitest";
import { ADMIN_ROLES, homePathForRole, isAdminRole, navItemsForRole } from "../lib/nav";

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
  it("teacher はエディタ + 音声/チャット入力 + コンテンツ + 掲示物 Q&A + 二要素認証 (#48-C 導線、F02 入力、F04 公開ハブ、F06 チャット、F11 MFA)。監視系 (ダッシュボード/月次レポート/センサー管理) は校務DX原則で運営専用に撤去", () => {
    const items = navItemsForRole("teacher");
    expect(items.map((i) => i.href)).toEqual([
      "/admin/editor",
      "/admin/teacher-input",
      "/admin/contents",
      "/admin/chat",
      "/admin/account/mfa",
    ]);
  });

  it("school_admin は学校管理 + 教職員 + エディタ + 音声/チャット入力 + コンテンツ + 掲示物 Q&A。監視系 (ダッシュボード/月次レポート/センサー管理) は校務DX原則で運営専用に撤去", () => {
    const hrefs = navItemsForRole("school_admin").map((i) => i.href);
    expect(hrefs).toContain("/admin/school");
    expect(hrefs).toContain("/admin/school/members");
    expect(hrefs).toContain("/admin/editor");
    expect(hrefs).toContain("/admin/teacher-input");
    expect(hrefs).toContain("/admin/contents");
    expect(hrefs).toContain("/admin/chat");
    // 監視系は学校側から撤去 (運営 = system_admin 専用)。
    expect(hrefs).not.toContain("/admin/dashboard");
    expect(hrefs).not.toContain("/admin/reports");
    expect(hrefs).not.toContain("/admin/sensors");
  });

  it("掲示物 Q&A (/admin/chat) は publisher (school_admin/teacher) のみ、system_admin には出さない (F06 #370、死リンク防止)", () => {
    // /admin/chat も /api/teacher/chat も requireRole(PUBLISHER_ROLES) で system_admin を 403 にする
    // ため、nav からも system_admin には出さない。生徒は /student の StudentChat (別経路) を使う。
    expect(navItemsForRole("system_admin").map((i) => i.href)).not.toContain("/admin/chat");
    expect(navItemsForRole("school_admin").map((i) => i.href)).toContain("/admin/chat");
    expect(navItemsForRole("teacher").map((i) => i.href)).toContain("/admin/chat");
  });

  it("教職員 (/admin/school/members) は school_admin 専用 (F11 第2スライス、自校運用)。teacher / system_admin には出さない (死リンク防止)", () => {
    // /admin/school/members は requireRole(["school_admin"]) で teacher / system_admin を 403 にする
    // ため、nav からも出さない (自校運用ビュー、system_admin の横断管理は別サーフェス)。
    expect(navItemsForRole("school_admin").map((i) => i.href)).toContain("/admin/school/members");
    expect(navItemsForRole("teacher").map((i) => i.href)).not.toContain("/admin/school/members");
    expect(navItemsForRole("system_admin").map((i) => i.href)).not.toContain(
      "/admin/school/members",
    );
  });

  it("音声/チャット入力 (/admin/teacher-input) は publisher (school_admin/teacher) のみ、system_admin には出さない (TEACHER_INPUT_STAFF_ROLES と整合・死リンク防止)", () => {
    // /admin/teacher-input は requireRole(TEACHER_INPUT_STAFF_ROLES=teacher/school_admin) で
    // system_admin を 403 にするため、nav からも system_admin には出さない。
    expect(navItemsForRole("system_admin").map((i) => i.href)).not.toContain(
      "/admin/teacher-input",
    );
    expect(navItemsForRole("school_admin").map((i) => i.href)).toContain("/admin/teacher-input");
    expect(navItemsForRole("teacher").map((i) => i.href)).toContain("/admin/teacher-input");
  });

  it("コンテンツ (/admin/contents) は publisher (school_admin/teacher) のみに出す (#166 と整合)", () => {
    // /admin/contents は requireRole(PUBLISHER_ROLES) で system_admin を 403 にするため、
    // nav からも system_admin には出さない (死リンク防止)。
    expect(navItemsForRole("system_admin").map((i) => i.href)).not.toContain("/admin/contents");
    expect(navItemsForRole("school_admin").map((i) => i.href)).toContain("/admin/contents");
    expect(navItemsForRole("teacher").map((i) => i.href)).toContain("/admin/contents");
  });

  it("ダッシュボード (/admin/dashboard) は誰の nav にも出さない (校務DX原則で運営専用に締め、school-side ルートは撤去。運営は /admin/system/dashboard を使う)", () => {
    // 自校ビュー /admin/dashboard は requireRole(SYSTEM_ADMIN_ROLES) に締めたため、school-side ロールの
    // nav からは撤去。system_admin は自校 /admin/dashboard ではなく全校版 /admin/system/dashboard を使う。
    expect(navItemsForRole("school_admin").map((i) => i.href)).not.toContain("/admin/dashboard");
    expect(navItemsForRole("teacher").map((i) => i.href)).not.toContain("/admin/dashboard");
    expect(navItemsForRole("system_admin").map((i) => i.href)).not.toContain("/admin/dashboard");
  });

  it("月次レポート (/admin/reports) は誰の nav にも出さない (校務DX原則で運営専用に締め、school-side ルートは撤去。運営は /admin/system/reports を使う)", () => {
    // 自校ビュー /admin/reports は requireRole(SYSTEM_ADMIN_ROLES) に締めたため、school-side ロールの nav
    // からは撤去。system_admin は自校 /admin/reports ではなく全校版 /admin/system/reports を使う。
    expect(navItemsForRole("school_admin").map((i) => i.href)).not.toContain("/admin/reports");
    expect(navItemsForRole("teacher").map((i) => i.href)).not.toContain("/admin/reports");
    expect(navItemsForRole("system_admin").map((i) => i.href)).not.toContain("/admin/reports");
  });

  it("system_admin は学校一覧 + 教職員管理 + 全校ダッシュボード + 全校センサー + 月次レポート + フィードバック + 二要素認証（自校エディタは出さない）", () => {
    const hrefs = navItemsForRole("system_admin").map((i) => i.href);
    expect(hrefs).toEqual([
      "/admin/system/schools",
      "/admin/system/users",
      "/admin/system/dashboard",
      "/admin/system/sensors",
      "/admin/system/reports",
      "/admin/system/feedback",
      "/admin/account/mfa",
    ]);
    expect(hrefs).not.toContain("/admin/editor");
  });

  it("センサー管理 (/admin/sensors) は誰の nav にも出さない (校務DX原則で運営専用に締め、school-side ルートは撤去。運営は /admin/system/sensors を使う)", () => {
    // 自校ビュー /admin/sensors は requireRole(SYSTEM_ADMIN_ROLES) に締めたため、school-side ロールの nav
    // からは撤去。system_admin は自校 /admin/sensors ではなく全校版 /admin/system/sensors を使う。
    expect(navItemsForRole("school_admin").map((i) => i.href)).not.toContain("/admin/sensors");
    expect(navItemsForRole("teacher").map((i) => i.href)).not.toContain("/admin/sensors");
    expect(navItemsForRole("system_admin").map((i) => i.href)).not.toContain("/admin/sensors");
  });

  it("センサー管理（全校） (/admin/system/sensors) は system_admin 専用 (F13 全校横断、自校 /admin/sensors とは別ルート)", () => {
    // /admin/system/sensors は requireRole(SYSTEM_ADMIN_ROLES) で publisher を 403 にするため、
    // nav からも publisher には出さない (死リンク防止)。自校ビュー /admin/sensors は別ルートで存続。
    expect(navItemsForRole("system_admin").map((i) => i.href)).toContain("/admin/system/sensors");
    expect(navItemsForRole("school_admin").map((i) => i.href)).not.toContain(
      "/admin/system/sensors",
    );
    expect(navItemsForRole("teacher").map((i) => i.href)).not.toContain("/admin/system/sensors");
  });

  it("教職員管理 (/admin/system/users) は system_admin 専用 (F11 全校横断、自校 /admin/school/members とは別)", () => {
    // /admin/system/users は requireRole(SYSTEM_ADMIN_ROLES) で publisher を 403 にするため、
    // nav からも publisher には出さない (死リンク防止)。自校ビュー /admin/school/members は別ルートで存続。
    expect(navItemsForRole("system_admin").map((i) => i.href)).toContain("/admin/system/users");
    expect(navItemsForRole("school_admin").map((i) => i.href)).not.toContain("/admin/system/users");
    expect(navItemsForRole("teacher").map((i) => i.href)).not.toContain("/admin/system/users");
  });

  it("全校ダッシュボード (/admin/system/dashboard) は system_admin 専用 (F08 第4スライス cross-tenant、自校 /admin/dashboard とは別ルート)", () => {
    // cross-tenant の横断ビューは requireRole(SYSTEM_ADMIN_ROLES) で publisher を 403 にするため、
    // nav からも publisher には出さない (死リンク防止)。自校ビュー /admin/dashboard は別ルートで存続。
    expect(navItemsForRole("system_admin").map((i) => i.href)).toContain("/admin/system/dashboard");
    expect(navItemsForRole("school_admin").map((i) => i.href)).not.toContain(
      "/admin/system/dashboard",
    );
    expect(navItemsForRole("teacher").map((i) => i.href)).not.toContain("/admin/system/dashboard");
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
    expect(homePathForRole("system_admin")).toBe("/admin/system/schools");
    expect(homePathForRole("school_admin")).toBe("/admin/school");
    expect(homePathForRole("teacher")).toBe("/admin/editor");
  });

  it("管理エリア対象外ロールはサイネージ (/) に倒す", () => {
    expect(homePathForRole("student")).toBe("/");
    expect(homePathForRole("guardian")).toBe("/");
  });
});
