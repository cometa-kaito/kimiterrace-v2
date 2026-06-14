import { describe, expect, it } from "vitest";
import { isRoleAllowed } from "../../lib/auth/guard";
import { SYSTEM_ADMIN_ROLES } from "../../lib/system-admin/roles";

// #48-L: /ops/* は requireRole(SYSTEM_ADMIN_ROLES) で gate する。requireRole は
// 内部で isRoleAllowed を使うため、ガード集合の振る舞いをここで直接固定する (誤って広げた場合に検出)。
describe("SYSTEM_ADMIN_ROLES (#48-L: /ops/* を system_admin 専用にする認可集合)", () => {
  it("system_admin のみ許可する", () => {
    expect(isRoleAllowed("system_admin", SYSTEM_ADMIN_ROLES)).toBe(true);
  });

  it("school_admin / teacher / student / guardian は除外する (横断運用は system_admin 限定)", () => {
    for (const role of ["school_admin", "teacher", "student", "guardian"] as const) {
      expect(isRoleAllowed(role, SYSTEM_ADMIN_ROLES), `role=${role}`).toBe(false);
    }
  });
});
