import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * クラス広告 Server Action の配線テスト (#48-J)。
 *
 * next/cache・guard・db を mock。`@kimiterrace/db` は `importOriginal` で実体を保ちつつ、
 * 読み取りヘルパ (`findVisibleClass` / `findClassOwnAd`) だけ差し替えて cross-tenant / not_found 経路を
 * 検証する。`withSession` は callback を fake tx で実行する (insert/update/delete はチェーンを満たす)。
 *
 * 重点: 認可 (ADS_ROLES / forbidden)、cross-tenant classId 拒否、継承広告(他スコープ)更新拒否、
 * 入力検証で DB に到達しないこと。
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../../lib/auth/guard", () => ({ requireRole: vi.fn() }));
vi.mock("../../lib/db", () => ({ withSession: vi.fn() }));

const findVisibleClassMock = vi.fn();
const findClassOwnAdMock = vi.fn();
vi.mock("@kimiterrace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@kimiterrace/db")>();
  return {
    ...actual,
    findVisibleClass: (...a: unknown[]) => findVisibleClassMock(...a),
    findClassOwnAd: (...a: unknown[]) => findClassOwnAdMock(...a),
  };
});

import { requireRole } from "../../lib/auth/guard";
import { withSession } from "../../lib/db";
import { createAdAction, deleteAdAction, updateAdAction } from "../../lib/school-admin/ads-actions";

const requireRoleMock = vi.mocked(requireRole);
const withSessionMock = vi.mocked(withSession);

const CLASS_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_CLASS_ID = "99999999-9999-4999-8999-999999999999";
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
  findVisibleClassMock.mockResolvedValue({ id: CLASS_ID, name: "1-A" });
  findClassOwnAdMock.mockResolvedValue({
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
  // withSession の実シグネチャは (tx, user) だが、テストでは tx のみ使う。
  withSessionMock.mockImplementation(((fn: (tx: unknown, user: unknown) => unknown) =>
    Promise.resolve(fn(fakeTx(), admin))) as typeof withSession);
});

describe("createAdAction", () => {
  it("不正な classId は invalid を返し、認可も走らせない", async () => {
    const res = await createAdAction("nope", VALID_AD);
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(requireRoleMock).not.toHaveBeenCalled();
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("検証 NG (非 http(s) URL) は DB に到達せず invalid", async () => {
    const res = await createAdAction(CLASS_ID, { ...VALID_AD, mediaUrl: "javascript:alert(1)" });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("ADS_ROLES (school_admin/system_admin) のみ認可する", async () => {
    await createAdAction(CLASS_ID, VALID_AD);
    expect(requireRoleMock).toHaveBeenCalledWith(["school_admin", "system_admin"]);
  });

  it("schoolId 無し (テナント未選択) は forbidden、DB に到達しない", async () => {
    requireRoleMock.mockResolvedValue({ uid: USER_ID, role: "system_admin", schoolId: null });
    const res = await createAdAction(CLASS_ID, VALID_AD);
    expect(res).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("cross-tenant: 自校で不可視なクラスは invalid (CrossTenantError 写像)", async () => {
    findVisibleClassMock.mockResolvedValue(null);
    const res = await createAdAction(OTHER_CLASS_ID, VALID_AD);
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
  });

  it("正常系: 作成して id を返す", async () => {
    const res = await createAdAction(CLASS_ID, VALID_AD);
    expect(res).toEqual({ ok: true, data: { id: "new-ad-1" } });
    expect(withSessionMock).toHaveBeenCalledTimes(1);
  });
});

describe("updateAdAction", () => {
  it("不正な adId は invalid、認可も走らせない", async () => {
    const res = await updateAdAction(CLASS_ID, "nope", VALID_AD);
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(requireRoleMock).not.toHaveBeenCalled();
  });

  it("対象広告が存在しない / 別スコープ (継承) は not_found", async () => {
    findClassOwnAdMock.mockResolvedValue(null);
    const res = await updateAdAction(CLASS_ID, AD_ID, VALID_AD);
    expect(res).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("対象広告が別クラス所属なら not_found (classId 不一致)", async () => {
    findClassOwnAdMock.mockResolvedValue({
      id: AD_ID,
      classId: OTHER_CLASS_ID,
      scope: "class",
      mediaUrl: "https://old.example.com/x.png",
      mediaType: "image",
      durationSec: 5,
      linkUrl: null,
      caption: null,
      captionFontScale: 1.0,
      displayOrder: 0,
    });
    const res = await updateAdAction(CLASS_ID, AD_ID, VALID_AD);
    expect(res).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("正常系: 更新して id を返す", async () => {
    const res = await updateAdAction(CLASS_ID, AD_ID, VALID_AD);
    expect(res).toEqual({ ok: true, data: { id: AD_ID } });
  });
});

describe("deleteAdAction", () => {
  it("不正な id は invalid", async () => {
    expect(await deleteAdAction("x", AD_ID)).toMatchObject({
      ok: false,
      error: { code: "invalid" },
    });
    expect(await deleteAdAction(CLASS_ID, "x")).toMatchObject({
      ok: false,
      error: { code: "invalid" },
    });
  });

  it("対象が無ければ not_found", async () => {
    findClassOwnAdMock.mockResolvedValue(null);
    const res = await deleteAdAction(CLASS_ID, AD_ID);
    expect(res).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("正常系: 削除して id を返す", async () => {
    const res = await deleteAdAction(CLASS_ID, AD_ID);
    expect(res).toEqual({ ok: true, data: { id: AD_ID } });
    expect(requireRoleMock).toHaveBeenCalledWith(["school_admin", "system_admin"]);
  });
});
