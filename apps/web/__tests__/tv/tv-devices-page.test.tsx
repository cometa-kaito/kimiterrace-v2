import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F15 §4.2 (ADR-022, #494 Reviewer Low-2): TV デバイス一覧の「編集」リンク出し分けを pin する。
 *
 * 一覧 (`/admin/tv-devices`) は `ADMIN_ROLES`（teacher 含む）が閲覧できるが、設定編集ページは
 * `TV_CONFIG_EDIT_ROLES`（school_admin / system_admin）限定。teacher に「編集」リンクを出すと 403 に
 * 終わる死リンクになるため、**編集可ロールのときだけ列ごと出す**（死リンク防止、`editor` ページの広告 /
 * 静粛時間リンク出し分けと同じ規律）。実体の認可は編集ページの `requireRole` + RLS が担保するので、本テストは
 * UX 層の出し分け（描画）だけを検証する。
 *
 * guard / db / `@kimiterrace/db` を mock し、`requireRole(ADMIN_ROLES)` で teacher も到達することを保ったまま
 * role を差し替えてリンクの有無を確認する。`isRoleAllowed` は純粋述語なので忠実な実装を差し込む
 * （副作用を持つ `requireRole` だけ vi.fn に置換、real `isRoleAllowed` は session.ts → next/headers を
 * 巻き込むため import しない）。
 */

vi.mock("../../lib/auth/guard", () => ({
  requireRole: vi.fn(),
  // real guard.ts の `isRoleAllowed` と等価な純粋述語（allowed.includes(role)）。
  isRoleAllowed: (role: string, allowed: readonly string[]) => allowed.includes(role),
}));
vi.mock("../../lib/db", () => ({ withSession: vi.fn() }));
vi.mock("@kimiterrace/db", () => ({ listTvDevices: vi.fn() }));

import { listTvDevices } from "@kimiterrace/db";
import TvDevicesPage from "../../app/admin/tv-devices/page";
import { requireRole } from "../../lib/auth/guard";
import { withSession } from "../../lib/db";
import { ADMIN_ROLES } from "../../lib/nav";
import { TV_CONFIG_EDIT_ROLES } from "../../lib/tv/config-edit-core";

const requireRoleMock = vi.mocked(requireRole);
const withSessionMock = vi.mocked(withSession);
const listMock = vi.mocked(listTvDevices);

// 一覧 1 行ぶんの最小 fixture。label は編集リンクの aria-label に使われる。
const DEVICE = {
  id: "00000000-0000-0000-0000-000000000001",
  label: "1年A組",
  deviceId: "dev-abcdef",
  targetMac: "AA:BB:CC:DD:EE:FF",
  version: 3,
  lastSeenAt: null,
  monitoringEnabled: true,
};
const EDIT_LINK_NAME = "1年A組 の設定を編集";

function arrangeRole(role: string) {
  requireRoleMock.mockResolvedValue({ uid: "u1", role, schoolId: "s1" } as never);
  withSessionMock.mockImplementation(((fn: (tx: unknown, user: unknown) => unknown) =>
    Promise.resolve(fn({}, { uid: "u1", role, schoolId: "s1" }))) as typeof withSession);
}

beforeEach(() => {
  vi.clearAllMocks();
  listMock.mockResolvedValue([DEVICE] as never);
});

describe("TvDevicesPage 編集リンクの role 出し分け", () => {
  it("一覧自体は ADMIN_ROLES（teacher 含む）で要求する", async () => {
    arrangeRole("teacher");
    await TvDevicesPage();
    expect(requireRoleMock).toHaveBeenCalledWith(ADMIN_ROLES);
    // 死リンク回避の前提: teacher は編集可ロールに含まれない。
    expect(TV_CONFIG_EDIT_ROLES).not.toContain("teacher");
  });

  it("teacher には「編集」リンクも「操作」列も出さない（死リンク防止）", async () => {
    arrangeRole("teacher");
    render(await TvDevicesPage());
    // 行自体は見える（一覧は閲覧可）。
    expect(screen.getByText("1年A組")).toBeInTheDocument();
    // 編集リンク・操作列ヘッダは無い。
    expect(screen.queryByRole("link", { name: EDIT_LINK_NAME })).toBeNull();
    expect(screen.queryByText("操作")).toBeNull();
  });

  it("school_admin には「編集」リンク（行 PK の編集ページ）を出す", async () => {
    arrangeRole("school_admin");
    render(await TvDevicesPage());
    const link = screen.getByRole("link", { name: EDIT_LINK_NAME });
    expect(link).toHaveAttribute("href", `/admin/tv-devices/${DEVICE.id}/edit`);
    expect(screen.getByText("操作")).toBeInTheDocument();
  });

  it("system_admin にも「編集」リンクを出す", async () => {
    arrangeRole("system_admin");
    render(await TvDevicesPage());
    expect(screen.getByRole("link", { name: EDIT_LINK_NAME })).toBeInTheDocument();
  });
});
