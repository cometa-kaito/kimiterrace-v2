import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F10 (#46): 広告主コミュニケーション履歴ページの認可配線 + 描画テスト。
 *
 * guard / db / 各 query / 子フォームを mock し、(1) system_admin 限定 (`requireRole(SYSTEM_ADMIN_ROLES)`)、
 * (2) `withSession` 経由で広告主詳細 + 履歴一覧を取得、(3) 履歴ありで一覧 (チャネルラベル/件名)、(4) 履歴
 * 0 件で空状態メッセージ、(5) 不正 id / 不存在広告主で notFound を固定する。RLS の実 0 件保証は
 * packages/db の RLS テストが担保 (多層防御、list-page.test と同方針)。
 */

vi.mock("@/lib/auth/guard", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/db", () => ({ withSession: vi.fn() }));
vi.mock("@/lib/system-admin/advertisers-queries", () => ({ getAdvertiserDetail: vi.fn() }));
vi.mock("@/lib/system-admin/communications-queries", () => ({
  listCommunicationsByAdvertiser: vi.fn(),
}));
const { notFound } = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));
vi.mock("next/navigation", () => ({ notFound }));
// 子フォーム ("use client") はサーバー描画テストでは差し替える (action import を持ち込まない)。
vi.mock(
  "../../app/admin/system/advertisers/[id]/communications/_components/CommunicationCreateForm",
  () => ({ CommunicationCreateForm: () => <div data-testid="create-form" /> }),
);

import AdvertiserCommunicationsPage from "../../app/admin/system/advertisers/[id]/communications/page";
import { requireRole } from "../../lib/auth/guard";
import { withSession } from "../../lib/db";
import { getAdvertiserDetail } from "../../lib/system-admin/advertisers-queries";
import { listCommunicationsByAdvertiser } from "../../lib/system-admin/communications-queries";
import { SYSTEM_ADMIN_ROLES } from "../../lib/system-admin/roles";

const requireRoleMock = vi.mocked(requireRole);
const withSessionMock = vi.mocked(withSession);
const getAdvertiserDetailMock = vi.mocked(getAdvertiserDetail);
const listMock = vi.mocked(listCommunicationsByAdvertiser);

const ADV_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ADVERTISER = { id: ADV_ID, companyName: "テスト広告株式会社" } as never;

beforeEach(() => {
  vi.clearAllMocks();
  notFound.mockImplementation(() => {
    throw new Error("NEXT_NOT_FOUND");
  });
  requireRoleMock.mockResolvedValue({ uid: "sys", role: "system_admin", schoolId: null } as never);
  getAdvertiserDetailMock.mockResolvedValue(ADVERTISER);
  listMock.mockResolvedValue([]);
  // withSession は callback を fake tx で実行する (list-page.test と同じキャスト)。
  withSessionMock.mockImplementation(((fn: (tx: unknown, user: unknown) => unknown) =>
    Promise.resolve(
      fn({}, { uid: "sys", role: "system_admin", schoolId: null }),
    )) as typeof withSession);
});

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("AdvertiserCommunicationsPage (#46 履歴ページ)", () => {
  it("system_admin 限定 + withSession 経由で広告主詳細と履歴一覧を取得する", async () => {
    await AdvertiserCommunicationsPage(params(ADV_ID));
    expect(requireRoleMock).toHaveBeenCalledWith(SYSTEM_ADMIN_ROLES);
    expect(getAdvertiserDetailMock).toHaveBeenCalledWith(expect.anything(), ADV_ID);
    expect(listMock).toHaveBeenCalledWith(expect.anything(), ADV_ID);
  });

  it("履歴ありで一覧 (チャネルラベル + 件名) を描画する", async () => {
    listMock.mockResolvedValue([
      {
        id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        contractId: null,
        channel: "meeting",
        occurredAt: new Date("2026-04-01T01:30:00.000Z"),
        subject: "初回商談メモ",
        createdAt: new Date("2026-04-02T02:00:00.000Z"),
      },
    ]);
    const ui = await AdvertiserCommunicationsPage(params(ADV_ID));
    render(ui);
    expect(screen.getByText("テスト広告株式会社 のコミュニケーション履歴")).toBeTruthy();
    expect(screen.getByText("商談")).toBeTruthy();
    expect(screen.getByText("初回商談メモ")).toBeTruthy();
  });

  it("履歴 0 件で空状態メッセージを描画する", async () => {
    listMock.mockResolvedValue([]);
    const ui = await AdvertiserCommunicationsPage(params(ADV_ID));
    render(ui);
    expect(screen.getByText("コミュニケーション履歴はまだ登録されていません。")).toBeTruthy();
  });

  it("不正な id は notFound (DB に到達しない)", async () => {
    await expect(AdvertiserCommunicationsPage(params("not-a-uuid"))).rejects.toThrow(
      /NEXT_NOT_FOUND/,
    );
    expect(withSessionMock).not.toHaveBeenCalled();
    expect(getAdvertiserDetailMock).not.toHaveBeenCalled();
  });

  it("広告主が不存在 (RLS 不可視含む) は notFound", async () => {
    getAdvertiserDetailMock.mockResolvedValue(null);
    await expect(AdvertiserCommunicationsPage(params(ADV_ID))).rejects.toThrow(/NEXT_NOT_FOUND/);
  });
});
