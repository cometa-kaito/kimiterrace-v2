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
  it("teacher はエディタのみ", () => {
    const items = navItemsForRole("teacher");
    expect(items.map((i) => i.href)).toEqual(["/admin/editor"]);
  });

  it("school_admin は学校管理 + エディタ", () => {
    const hrefs = navItemsForRole("school_admin").map((i) => i.href);
    expect(hrefs).toContain("/admin/school");
    expect(hrefs).toContain("/admin/editor");
  });

  it("system_admin は学校一覧 + フィードバック（自校エディタは出さない）", () => {
    const hrefs = navItemsForRole("system_admin").map((i) => i.href);
    expect(hrefs).toEqual(["/admin/system/schools", "/admin/system/feedback"]);
    expect(hrefs).not.toContain("/admin/editor");
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
