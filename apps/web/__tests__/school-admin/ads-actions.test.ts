import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 広告 Server Action の配線テスト (#48-J、scope 対応版)。
 *
 * next/cache・guard・db を mock。`@kimiterrace/db` は `importOriginal` で実体を保ちつつ、
 * 読み取りヘルパ (`findVisibleTarget` / `findOwnAd`) だけ差し替えて cross-tenant / not_found 経路を
 * 検証する。`withSession` は callback を fake tx で実行する (insert/update/delete はチェーンを満たす)。
 *
 * 重点: 認可 (ADS_ROLES / forbidden)、scope (class/school/grade) 受理、cross-tenant ターゲット拒否、
 * 継承広告(別スコープ)更新拒否 (findOwnAd null)、入力検証で DB に到達しないこと。
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../../lib/auth/guard", () => ({ requireRole: vi.fn() }));
vi.mock("../../lib/db", () => ({ withSession: vi.fn() }));

const findVisibleTargetMock = vi.fn();
const findOwnAdMock = vi.fn();
vi.mock("@kimiterrace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@kimiterrace/db")>();
  return {
    ...actual,
    findVisibleTarget: (...a: unknown[]) => findVisibleTargetMock(...a),
    findOwnAd: (...a: unknown[]) => findOwnAdMock(...a),
  };
});

import { requireRole } from "../../lib/auth/guard";
import { withSession } from "../../lib/db";
import { createAdAction, deleteAdAction, updateAdAction } from "../../lib/school-admin/ads-actions";

const requireRoleMock = vi.mocked(requireRole);
const withSessionMock = vi.mocked(withSession);

const CLASS_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_CLASS_ID = "99999999-9999-4999-8999-999999999999";
const GRADE_ID = "55555555-5555-4555-8555-555555555555";
const AD_ID = "44444444-4444-4444-8444-444444444444";
const SCHOOL_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";

const admin = { uid: USER_ID, role: "school_admin" as const, schoolId: SCHOOL_ID };

const VALID_AD = {
  mediaUrl: "https://cdn.example.com/a.png",
  mediaType: "image",
  durationSec: 8,
  captionFontScale: 1.3,
  displayOrder: 1,
};

/** insert/update/delete のチェーン (.values/.set/.where/.returning) を満たす fake tx。 */
function fakeTx() {
  const insertedId = "new-ad-1";
  const chain = {
    values: () => chain,
    set: () => chain,
    where: () => Promise.resolve(undefined),
    returning: () => Promise.resolve([{ id: insertedId }]),
  };
  return {
    insert: () => chain,
    update: () => chain,
    delete: () => chain,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireRoleMock.mockResolvedValue(admin);
  findVisibleTargetMock.mockResolvedValue({ name: "1-A" });
  findOwnAdMock.mockResolvedValue({
    id: AD_ID,
    classId: CLASS_ID,
    scope: "class",
    mediaUrl: "https://old.example.com/x.png",
    mediaType: "image",
    durationSec: 5,
    linkUrl: null,
    caption: null,
    captionFontScale: 1.0,
    displayOrder: 0,
  });
  // callback を fake tx で実行 (cross-tenant / not_found 経路を通すため)。
  withSessionMock.mockImplementation(((fn: (tx: unknown, user: unknown) => unknown) =>
    Promise.resolve(fn(fakeTx(), admin))) as typeof withSession);
});

describe("createAdAction", () => {
  it("不正な targetId (class) は invalid を返し、認可も走らせない", async () => {
    const res = await createAdAction("class", "nope", VALID_AD);
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(requireRoleMock).not.toHaveBeenCalled();
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("不正な scope は invalid を返す", async () => {
    const res = await createAdAction("bogus", CLASS_ID, VALID_AD);
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("検証 NG (非 http(s) URL) は DB に到達せず invalid", async () => {
    const res = await createAdAction("class", CLASS_ID, {
      ...VALID_AD,
      mediaUrl: "javascript:alert(1)",
    });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("ADS_ROLES (school_admin/system_admin) のみ認可する", async () => {
    await createAdAction("class", CLASS_ID, VALID_AD);
    expect(requireRoleMock).toHaveBeenCalledWith(["school_admin", "system_admin"]);
  });

  it("schoolId 無し (テナント未選択) は forbidden、DB に到達しない", async () => {
    requireRoleMock.mockResolvedValue({ uid: USER_ID, role: "system_admin", schoolId: null });
    const res = await createAdAction("class", CLASS_ID, VALID_AD);
    expect(res).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("cross-tenant: 自校で不可視なターゲットは invalid (CrossTenantError 写像)", async () => {
    findVisibleTargetMock.mockResolvedValue(null);
    const res = await createAdAction("class", OTHER_CLASS_ID, VALID_AD);
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
  });

  it("正常系 (class): 作成して id を返す", async () => {
    const res = await createAdAction("class", CLASS_ID, VALID_AD);
    expect(res).toEqual({ ok: true, data: { id: "new-ad-1" } });
    expect(withSessionMock).toHaveBeenCalledTimes(1);
    // cross-tenant 防御: system_admin 降格 (tenantScoped) で実行する (ADR-019 §#95、ルール2)。
    expect(withSessionMock).toHaveBeenCalledWith(expect.any(Function), { tenantScoped: true });
  });

  it("正常系 (school スコープ, id 不要): 作成して id を返す", async () => {
    const res = await createAdAction("school", null, VALID_AD);
    expect(res).toEqual({ ok: true, data: { id: "new-ad-1" } });
  });

  it("正常系 (grade スコープ): 作成して id を返す", async () => {
    const res = await createAdAction("grade", GRADE_ID, VALID_AD);
    expect(res).toEqual({ ok: true, data: { id: "new-ad-1" } });
  });

  it("cross-tenant (grade): 自校で不可視な学年は invalid", async () => {
    findVisibleTargetMock.mockResolvedValue(null);
    const res = await createAdAction("grade", GRADE_ID, VALID_AD);
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
  });
});

describe("updateAdAction", () => {
  it("不正な adId は invalid、認可も走らせない", async () => {
    const res = await updateAdAction("class", CLASS_ID, "nope", VALID_AD);
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(requireRoleMock).not.toHaveBeenCalled();
  });

  it("対象広告が存在しない / 別スコープ・別ターゲット (findOwnAd null) は not_found", async () => {
    findOwnAdMock.mockResolvedValue(null);
    const res = await updateAdAction("class", CLASS_ID, AD_ID, VALID_AD);
    expect(res).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("正常系 (class): 更新して id を返す", async () => {
    const res = await updateAdAction("class", CLASS_ID, AD_ID, VALID_AD);
    expect(res).toEqual({ ok: true, data: { id: AD_ID } });
  });

  it("正常系 (grade スコープ): 更新して id を返す", async () => {
    const res = await updateAdAction("grade", GRADE_ID, AD_ID, VALID_AD);
    expect(res).toEqual({ ok: true, data: { id: AD_ID } });
  });
});

describe("deleteAdAction", () => {
  it("不正な id は invalid", async () => {
    expect(await deleteAdAction("class", "x", AD_ID)).toMatchObject({
      ok: false,
      error: { code: "invalid" },
    });
    expect(await deleteAdAction("class", CLASS_ID, "x")).toMatchObject({
      ok: false,
      error: { code: "invalid" },
    });
  });

  it("対象が無ければ not_found", async () => {
    findOwnAdMock.mockResolvedValue(null);
    const res = await deleteAdAction("class", CLASS_ID, AD_ID);
    expect(res).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("正常系 (class): 削除して id を返す", async () => {
    const res = await deleteAdAction("class", CLASS_ID, AD_ID);
    expect(res).toEqual({ ok: true, data: { id: AD_ID } });
    expect(requireRoleMock).toHaveBeenCalledWith(["school_admin", "system_admin"]);
  });
});
