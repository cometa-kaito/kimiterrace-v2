import type { TenantRole } from "@kimiterrace/db";
import { describe, expect, it } from "vitest";
import { isRoleAllowed } from "../../lib/auth/guard";
import { PUBLISHER_ROLES } from "../../lib/contents/publish-core";
import { ADMIN_ROLES } from "../../lib/nav";
import { MEMBER_ADMIN_ROLES } from "../../lib/role-management/roles";
import { SYSTEM_ADMIN_ROLES } from "../../lib/system-admin/roles";
import { TEACHER_INPUT_STAFF_ROLES } from "../../lib/teacher-input/roles";

/**
 * 認可マトリクス (横断): 全 role gate 定数 × 全 TenantRole の越権拒否網羅監査。
 *
 * RLS は tenant 境界のみを守り role 境界を守らない ([[rls-tenant-not-role-boundary]])。よって
 * 「どの role がどの管理面に入れるか」は各 handler の requireRole / withSession({allowedRoles}) が担い、
 * その許可集合 = 本 gate 定数群が単一ソース。本スイートは個別 action テスト (roles/policy/member-actions
 * 等) を横断し、全 gate × 全 role の許可/拒否を 1 つのマトリクスで固定する。
 *
 * 新規価値 (既存個別テストと二重化しない):
 * - config typo 検出: gate 定数に誤って role を足す/外すと期待マトリクスと不一致で fail
 *   (例: MEMBER_ADMIN_ROLES に teacher 誤追加 → 自校教職員管理の越権穴を CI が検知)。
 * - 越権網羅: student/guardian (最下位) が**いかなる管理 gate にも入れない**ことを全 gate で固定。
 * - enum 追従: ALL_ROLES が TenantRole 全網羅であることを型で保証 (新 role 追加時の監査漏れ防止)。
 *
 * route が「正しい gate を実際に requireRole で適用しているか」の実 HTTP 検証は E2E
 * (Playwright + Auth emulator + role 別 storageState) の領域 (test-strategy §2.1)。本スイートは
 * 「gate 定数自体が意図どおりの role 集合か」の pure function 監査に集中する。
 */

// 全 TenantRole を網羅 (型で enum とのズレを検出、session.ts の _ExhaustiveRoleCheck と同思想)。
const ALL_ROLES = [
  "system_admin",
  "school_admin",
  "teacher",
  "student",
  "guardian",
] as const satisfies readonly TenantRole[];
type _ExhaustiveRoleCheck =
  Exclude<TenantRole, (typeof ALL_ROLES)[number]> extends never ? true : never;
const _exhaustive: _ExhaustiveRoleCheck = true;
void _exhaustive;

// 各 gate 定数の「許可されるべき role 集合」を単一ソースとして宣言 (実装の現状をピン留め)。
// gate (実装の定数) と allow (期待) がズレたら下のマトリクスが fail し、config 誤りを検知する。
const GATES: { name: string; gate: readonly TenantRole[]; allow: ReadonlySet<string> }[] = [
  { name: "SYSTEM_ADMIN_ROLES", gate: SYSTEM_ADMIN_ROLES, allow: new Set(["system_admin"]) },
  { name: "MEMBER_ADMIN_ROLES", gate: MEMBER_ADMIN_ROLES, allow: new Set(["school_admin"]) },
  { name: "PUBLISHER_ROLES", gate: PUBLISHER_ROLES, allow: new Set(["school_admin", "teacher"]) },
  {
    name: "TEACHER_INPUT_STAFF_ROLES",
    gate: TEACHER_INPUT_STAFF_ROLES,
    allow: new Set(["teacher", "school_admin"]),
  },
  {
    name: "ADMIN_ROLES",
    gate: ADMIN_ROLES,
    allow: new Set(["system_admin", "school_admin", "teacher"]),
  },
];

describe("認可マトリクス: gate 定数 × 全 role の越権拒否網羅 (横断)", () => {
  for (const { name, gate, allow } of GATES) {
    describe(name, () => {
      for (const role of ALL_ROLES) {
        const expected = allow.has(role);
        it(`${role} → ${expected ? "許可" : "拒否 (越権不能)"}`, () => {
          expect(isRoleAllowed(role, gate)).toBe(expected);
        });
      }
    });
  }

  it("全 gate 定数の要素は TenantRole (enum) のサブセット (未知 role が紛れない)", () => {
    const known = new Set<string>(ALL_ROLES);
    for (const { name, gate } of GATES) {
      for (const r of gate) {
        expect(known.has(r), `${name} に未知 role ${r}`).toBe(true);
      }
    }
  });

  it("student / guardian は全管理 gate で拒否 (最下位 role の越権不能)", () => {
    for (const role of ["student", "guardian"] as const) {
      for (const { name, gate } of GATES) {
        expect(isRoleAllowed(role, gate), `${role} が ${name} を通過`).toBe(false);
      }
    }
  });
});
