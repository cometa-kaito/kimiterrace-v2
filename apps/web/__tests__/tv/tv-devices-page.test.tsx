import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F15 §4.2 / F16 §5 (ADR-022/ADR-023, #494 Reviewer Low-2): TV デバイス一覧の「操作」列リンク出し分けを pin する。
 *
 * 一覧 (`/admin/tv-devices`) は `ADMIN_ROLES`（teacher 含む）が閲覧できる。操作列には:
 *  - **稼働履歴**（F16 §5、`/[id]/history`）: 閲覧専用ページで ADMIN_ROLES 全員に出す（teacher も到達可）。
 *  - **設定編集**（F15 §4.2、`/[id]/edit`）: `TV_CONFIG_EDIT_ROLES`（school_admin / system_admin）限定。
 *    teacher に出すと 403 に終わる死リンクになるため、**編集可ロールのときだけ**出す（死リンク防止）。
 * 操作列ヘッダ自体は履歴リンクが全員に出るため常に表示する。実体の認可は各ページの `requireRole` + RLS が
 * 担保するので、本テストは UX 層の出し分け（描画）だけを検証する。
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
const HISTORY_LINK_NAME = "1年A組 の稼働履歴を表示";

function arrangeRole(role: string) {
  requireRoleMock.mockResolvedValue({ uid: "u1", role, schoolId: "s1" } as never);
  withSessionMock.mockImplementation(((fn: (tx: unknown, user: unknown) => unknown) =>
    Promise.resolve(fn({}, { uid: "u1", role, schoolId: "s1" }))) as typeof withSession);
}

beforeEach(() => {
  vi.clearAllMocks();
  listMock.mockResolvedValue([DEVICE] as never);
});

describe("TvDevicesPage 操作列リンクの role 出し分け", () => {
  it("一覧自体は ADMIN_ROLES（teacher 含む）で要求する", async () => {
    arrangeRole("teacher");
    await TvDevicesPage();
    expect(requireRoleMock).toHaveBeenCalledWith(ADMIN_ROLES);
    // 死リンク回避の前提: teacher は編集可ロールに含まれない。
    expect(TV_CONFIG_EDIT_ROLES).not.toContain("teacher");
  });

  it("teacher には「履歴」リンクは出すが「編集」リンクは出さない（履歴は閲覧専用、編集は死リンク防止）", async () => {
    arrangeRole("teacher");
    render(await TvDevicesPage());
    // 行自体は見える（一覧は閲覧可）。
    expect(screen.getByText("1年A組")).toBeInTheDocument();
    // 稼働履歴は ADMIN_ROLES 全員に出る（行 PK の履歴ページ、F16 §5）。
    const history = screen.getByRole("link", { name: HISTORY_LINK_NAME });
    expect(history).toHaveAttribute("href", `/admin/tv-devices/${DEVICE.id}/history`);
    // 操作列ヘッダは履歴リンクのため常に出る。編集リンクだけが teacher には無い（死リンク防止）。
    expect(screen.getByText("操作")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: EDIT_LINK_NAME })).toBeNull();
  });

  it("school_admin には「編集」リンク（行 PK の編集ページ）と「履歴」リンクを出す", async () => {
    arrangeRole("school_admin");
    render(await TvDevicesPage());
    const link = screen.getByRole("link", { name: EDIT_LINK_NAME });
    expect(link).toHaveAttribute("href", `/admin/tv-devices/${DEVICE.id}/edit`);
    expect(screen.getByRole("link", { name: HISTORY_LINK_NAME })).toHaveAttribute(
      "href",
      `/admin/tv-devices/${DEVICE.id}/history`,
    );
    expect(screen.getByText("操作")).toBeInTheDocument();
  });

  it("system_admin にも「編集」リンクを出す", async () => {
    arrangeRole("system_admin");
    render(await TvDevicesPage());
    expect(screen.getByRole("link", { name: EDIT_LINK_NAME })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: HISTORY_LINK_NAME })).toBeInTheDocument();
  });
});
