import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F12 (#48-M): system_admin フィードバック一覧ページの認可配線テスト。
 *
 * guard / db / @kimiterrace/db を mock し、ページが **system_admin に限定** されていること
 * (`requireRole(SYSTEM_ADMIN_ROLES)`) と、`withSession` 経由で `listFeedback` を呼ぶことを固定する。
 * 非 system_admin の 403 は requireRole の本物挙動 (redirect /forbidden) を mock の throw で再現し、
 * DB に到達しないことを検証する。RLS の実 0 件保証は packages/db の RLS テストが担保 (多層防御)。
 */

vi.mock("../../lib/auth/guard", () => ({ requireRole: vi.fn() }));
vi.mock("../../lib/db", () => ({ withSession: vi.fn() }));
vi.mock("@kimiterrace/db", () => ({ listFeedback: vi.fn() }));

import { listFeedback } from "@kimiterrace/db";
import SystemFeedbackPage from "../../app/admin/system/feedback/page";
import { requireRole } from "../../lib/auth/guard";
import { withSession } from "../../lib/db";
import { SYSTEM_ADMIN_ROLES } from "../../lib/system-admin/roles";

const requireRoleMock = vi.mocked(requireRole);
const withSessionMock = vi.mocked(withSession);
const listFeedbackMock = vi.mocked(listFeedback);

beforeEach(() => {
  requireRoleMock.mockReset();
  withSessionMock.mockReset();
  listFeedbackMock.mockReset();
  listFeedbackMock.mockResolvedValue([]);
  // withSession は callback を fake tx で実行する (schools-actions.test.ts と同じキャスト)。
  withSessionMock.mockImplementation(((fn: (tx: unknown, user: unknown) => unknown) =>
    Promise.resolve(
      fn({}, { uid: "sys", role: "system_admin", schoolId: null }),
    )) as typeof withSession);
});

describe("SystemFeedbackPage 認可配線", () => {
  it("system_admin 限定 (requireRole が SYSTEM_ADMIN_ROLES で呼ばれる) + listFeedback を呼ぶ", async () => {
    requireRoleMock.mockResolvedValue({
      uid: "sys",
      role: "system_admin",
      schoolId: null,
    } as never);

    await SystemFeedbackPage();

    expect(requireRoleMock).toHaveBeenCalledWith(SYSTEM_ADMIN_ROLES);
    expect(listFeedbackMock).toHaveBeenCalledTimes(1);
  });

  it("非 system_admin は requireRole が弾く (redirect 相当の throw) → DB に到達しない", async () => {
    requireRoleMock.mockRejectedValue(new Error("NEXT_REDIRECT /forbidden"));

    await expect(SystemFeedbackPage()).rejects.toThrow(/NEXT_REDIRECT/);
    expect(withSessionMock).not.toHaveBeenCalled();
    expect(listFeedbackMock).not.toHaveBeenCalled();
  });
});
