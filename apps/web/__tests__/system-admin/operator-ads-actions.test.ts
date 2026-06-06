import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F10 / #46: 運営側広告 CRM の Server Action 配線テスト。next/cache・guard・db を mock し、
 * `@kimiterrace/db` は importOriginal で実体を保ちつつ `getSchoolDetail` を差し替え、advertisers-queries の
 * `getAdvertiserDetail` も mock する。`withSession` は fake tx で callback を実行する。
 *
 * 重点: 入力検証で DB/認可に到達しないこと、SYSTEM_ADMIN_ROLES 認可、広告主/学校 not_found、正常系の
 * 作成/削除、削除は advertiser_id 有り (運営広告) のみ対象 (学校クラス広告は select で 0 件 → not_found)。
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../../lib/auth/guard", () => ({ requireRole: vi.fn() }));
vi.mock("../../lib/db", () => ({ withSession: vi.fn() }));

const getSchoolDetailMock = vi.fn();
vi.mock("@kimiterrace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@kimiterrace/db")>();
  return { ...actual, getSchoolDetail: (...a: unknown[]) => getSchoolDetailMock(...a) };
});

const getAdvertiserDetailMock = vi.fn();
vi.mock("../../lib/system-admin/advertisers-queries", () => ({
  getAdvertiserDetail: (...a: unknown[]) => getAdvertiserDetailMock(...a),
}));

import { requireRole } from "../../lib/auth/guard";
import { withSession } from "../../lib/db";
import {
  createOperatorAdAction,
  deleteOperatorAdAction,
} from "../../lib/system-admin/operator-ads-actions";

const requireRoleMock = vi.mocked(requireRole);
const withSessionMock = vi.mocked(withSession);

const ADV_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SCHOOL_ID = "22222222-2222-4222-8222-222222222222";
const AD_ID = "44444444-4444-4444-8444-444444444444";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const sysAdmin = { uid: USER_ID, role: "system_admin" as const, schoolId: null };

const VALID = {
  advertiserId: ADV_ID,
  schoolId: SCHOOL_ID,
  mediaUrl: "https://cdn.example.com/ad.png",
  mediaType: "image",
  durationSec: 10,
};

/** insert(.values/.returning) / delete(.where) / select(.from/.where/.limit) を満たす fake tx。 */
function makeTx(selectRows: unknown[]) {
  const chain = {
    values: () => chain,
    returning: () => Promise.resolve([{ id: "new-ad-1" }]),
    where: () => Promise.resolve(undefined),
  };
  const selectChain = {
    from: () => selectChain,
    where: () => selectChain,
    limit: () => Promise.resolve(selectRows),
  };
  return { insert: () => chain, delete: () => chain, select: () => selectChain };
}

function useTx(selectRows: unknown[] = []) {
  withSessionMock.mockImplementation(((fn: (tx: unknown, user: unknown) => unknown) =>
    Promise.resolve(fn(makeTx(selectRows), sysAdmin))) as typeof withSession);
}

beforeEach(() => {
  vi.clearAllMocks();
  requireRoleMock.mockResolvedValue(sysAdmin);
  getAdvertiserDetailMock.mockResolvedValue({ id: ADV_ID, companyName: "アクメ商事" });
  getSchoolDetailMock.mockResolvedValue({ school: { id: SCHOOL_ID }, counts: {} });
  useTx([{ id: AD_ID, schoolId: SCHOOL_ID, advertiserId: ADV_ID }]);
});

describe("createOperatorAdAction", () => {
  it("不正な advertiserId は invalid、認可/DB に到達しない", async () => {
    const res = await createOperatorAdAction({ ...VALID, advertiserId: "nope" });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(requireRoleMock).not.toHaveBeenCalled();
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("不正な schoolId は invalid", async () => {
    const res = await createOperatorAdAction({ ...VALID, schoolId: "nope" });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(requireRoleMock).not.toHaveBeenCalled();
  });

  it("検証 NG (非 http(s) メディア URL) は DB に到達せず invalid", async () => {
    const res = await createOperatorAdAction({ ...VALID, mediaUrl: "javascript:alert(1)" });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("SYSTEM_ADMIN_ROLES のみ認可する", async () => {
    await createOperatorAdAction(VALID);
    expect(requireRoleMock).toHaveBeenCalledWith(["system_admin"]);
  });

  it("広告主が存在しないと not_found", async () => {
    getAdvertiserDetailMock.mockResolvedValue(null);
    const res = await createOperatorAdAction(VALID);
    expect(res).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("学校が存在しないと not_found", async () => {
    getSchoolDetailMock.mockResolvedValue(null);
    const res = await createOperatorAdAction(VALID);
    expect(res).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("正常系: 作成して id を返す", async () => {
    const res = await createOperatorAdAction(VALID);
    expect(res).toEqual({ ok: true, data: { id: "new-ad-1" } });
    expect(withSessionMock).toHaveBeenCalledTimes(1);
  });
});

describe("deleteOperatorAdAction", () => {
  it("不正な adId は invalid、認可に到達しない", async () => {
    const res = await deleteOperatorAdAction("nope");
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(requireRoleMock).not.toHaveBeenCalled();
  });

  it("対象 (advertiser_id 有り) が無ければ not_found (学校クラス広告は select 0 件)", async () => {
    useTx([]); // select が 0 件 = 運営広告でない / 不存在
    const res = await deleteOperatorAdAction(AD_ID);
    expect(res).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("正常系: 削除して id を返す", async () => {
    const res = await deleteOperatorAdAction(AD_ID);
    expect(res).toEqual({ ok: true, data: { id: AD_ID } });
    expect(requireRoleMock).toHaveBeenCalledWith(["system_admin"]);
  });
});
