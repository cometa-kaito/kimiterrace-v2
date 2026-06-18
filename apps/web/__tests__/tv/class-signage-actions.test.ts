import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ADR-042 D6: TV デバイス作成フォームのクラス選択化を支える Server Action の配線テスト。
 *
 * 実 DB / 実 Identity Platform は使わず、guard (requireRole) / db (withSession) / origin / db ドメイン関数 /
 * token 生成を mock し、**Action の責務**（認可・再利用 vs 新規発行・cross-tenant 解決・無期限/平文保存・URL 組立）
 * を検証する。RLS の実挙動は packages/db の RLS テスト（実 PG）が担保する。
 *
 * vi.mock は巻き上げられるため、factory が参照するモックは vi.hoisted で先に用意する。
 */

const {
  getRequestOrigin,
  generateToken,
  hashToken,
  getVisibleClassSchoolId,
  listClassMagicLinks,
  createClassMagicLink,
  listSchoolClassesForAdPlacement,
} = vi.hoisted(() => ({
  getRequestOrigin: vi.fn(),
  generateToken: vi.fn(() => "FRESH_TOKEN"),
  hashToken: vi.fn(() => "HASHED"),
  getVisibleClassSchoolId: vi.fn(),
  listClassMagicLinks: vi.fn(),
  createClassMagicLink: vi.fn(),
  listSchoolClassesForAdPlacement: vi.fn(),
}));

vi.mock("../../lib/auth/guard", () => ({ requireRole: vi.fn() }));
vi.mock("../../lib/db", () => ({ withSession: vi.fn() }));
vi.mock("../../lib/http/request-origin", () => ({ getRequestOrigin }));
vi.mock("../../lib/magic-link/token", () => ({ generateToken, hashToken }));
vi.mock("../../lib/system-admin/ad-placement-queries", () => ({ listSchoolClassesForAdPlacement }));
vi.mock("@kimiterrace/db", () => ({
  getVisibleClassSchoolId,
  listClassMagicLinks,
  createClassMagicLink,
}));

import { requireRole } from "../../lib/auth/guard";
import { withSession } from "../../lib/db";
import {
  getOrCreateClassSignageUrl,
  listClassesForSchoolAction,
} from "../../lib/tv/class-signage-actions";

const requireRoleMock = vi.mocked(requireRole);
const withSessionMock = vi.mocked(withSession);

const SCHOOL_ID = "11111111-1111-4111-8111-111111111111";
const CLASS_ID = "22222222-2222-4222-8222-222222222222";
const SYSADMIN_UID = "sysadmin-uid-xyz";

const sysadmin = { uid: SYSADMIN_UID, role: "system_admin" as const, schoolId: null };

/** listClassMagicLinks の戻り形（IssuedMagicLink 部分）。 */
function link(over: Partial<{ id: string; token: string | null; revokedAt: Date | null }>) {
  return {
    id: over.id ?? "link-1",
    classId: CLASS_ID,
    token: over.token ?? null,
    expiresAt: null,
    revokedAt: over.revokedAt ?? null,
    createdAt: new Date("2026-06-18T00:00:00Z"),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireRoleMock.mockResolvedValue(sysadmin);
  getRequestOrigin.mockResolvedValue("https://app.school-signage.net");
  getVisibleClassSchoolId.mockResolvedValue(SCHOOL_ID);
  // withSession は callback を fake tx (空) で実行する（DB クエリ自体は mock 済）。
  withSessionMock.mockImplementation(((fn: (tx: unknown, user: unknown) => unknown) =>
    Promise.resolve(fn({}, sysadmin))) as typeof withSession);
});

describe("getOrCreateClassSignageUrl", () => {
  it("classId 不正 → invalid、origin・認可・DB に到達しない", async () => {
    const res = await getOrCreateClassSignageUrl("nope");
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(getRequestOrigin).not.toHaveBeenCalled();
    expect(requireRoleMock).not.toHaveBeenCalled();
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("ONBOARDING_ROLES (system_admin) のみ認可する", async () => {
    listClassMagicLinks.mockResolvedValue([link({ token: "EXISTING" })]);
    await getOrCreateClassSignageUrl(CLASS_ID);
    expect(requireRoleMock).toHaveBeenCalledWith(["system_admin"]);
  });

  it("既存の有効リンク（平文 token あり）があれば再利用し、新規発行しない", async () => {
    listClassMagicLinks.mockResolvedValue([
      link({ id: "newest", token: "REUSE_ME" }),
      link({ id: "older", token: "OTHER" }),
    ]);
    const res = await getOrCreateClassSignageUrl(CLASS_ID);
    expect(res).toEqual({
      ok: true,
      data: { signageUrl: "https://app.school-signage.net/signage/REUSE_ME" },
    });
    // 再利用なので発行は呼ばれない。
    expect(createClassMagicLink).not.toHaveBeenCalled();
    expect(generateToken).not.toHaveBeenCalled();
  });

  it("有効リンクが無ければ無期限・平文保存で新規発行する", async () => {
    listClassMagicLinks.mockResolvedValue([]);
    createClassMagicLink.mockResolvedValue({
      id: "issued-1",
      classId: CLASS_ID,
      token: "FRESH_TOKEN",
      expiresAt: null,
      revokedAt: null,
      createdAt: new Date(),
    });
    const res = await getOrCreateClassSignageUrl(CLASS_ID);
    expect(res).toEqual({
      ok: true,
      data: { signageUrl: "https://app.school-signage.net/signage/FRESH_TOKEN" },
    });
    // 発行は school 解決値 + 平文 token + hash で、expiresAt は **未指定（無期限 NULL）**・actor は system_admin。
    expect(createClassMagicLink).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        schoolId: SCHOOL_ID,
        classId: CLASS_ID,
        token: "FRESH_TOKEN",
        tokenHash: "HASHED",
        actor: { userId: null, identityUid: SYSADMIN_UID },
      }),
    );
    const passed = createClassMagicLink.mock.calls[0]?.[1] as { expiresAt?: unknown };
    expect(passed.expiresAt).toBeUndefined();
  });

  it("token 列が NULL の旧リンクのみのときは再利用せず新規発行する", async () => {
    listClassMagicLinks.mockResolvedValue([link({ id: "legacy", token: null })]);
    createClassMagicLink.mockResolvedValue({
      id: "issued-2",
      classId: CLASS_ID,
      token: "FRESH_TOKEN",
      expiresAt: null,
      revokedAt: null,
      createdAt: new Date(),
    });
    const res = await getOrCreateClassSignageUrl(CLASS_ID);
    expect(res.ok).toBe(true);
    expect(createClassMagicLink).toHaveBeenCalledTimes(1);
  });

  it("他校クラスを system_admin が解決できる（getVisibleClassSchoolId 経由で発行先 school を決める）", async () => {
    const OTHER_SCHOOL = "33333333-3333-4333-8333-333333333333";
    getVisibleClassSchoolId.mockResolvedValue(OTHER_SCHOOL);
    listClassMagicLinks.mockResolvedValue([]);
    createClassMagicLink.mockResolvedValue({
      id: "x",
      classId: CLASS_ID,
      token: "FRESH_TOKEN",
      expiresAt: null,
      revokedAt: null,
      createdAt: new Date(),
    });
    await getOrCreateClassSignageUrl(CLASS_ID);
    expect(createClassMagicLink).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ schoolId: OTHER_SCHOOL }),
    );
  });

  it("クラスが不可視/不存在（school 解決 null）→ invalid、発行しない", async () => {
    getVisibleClassSchoolId.mockResolvedValue(null);
    const res = await getOrCreateClassSignageUrl(CLASS_ID);
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(createClassMagicLink).not.toHaveBeenCalled();
  });

  it("origin 解決不能 → invalid、認可・DB に到達しない", async () => {
    getRequestOrigin.mockResolvedValue(null);
    const res = await getOrCreateClassSignageUrl(CLASS_ID);
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(requireRoleMock).not.toHaveBeenCalled();
    expect(withSessionMock).not.toHaveBeenCalled();
  });
});

describe("listClassesForSchoolAction", () => {
  it("schoolId 不正 → invalid、認可・DB に到達しない", async () => {
    const res = await listClassesForSchoolAction("nope");
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(requireRoleMock).not.toHaveBeenCalled();
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("クラス制は『学年 組』、学科制は『学科 学年』でラベル整形して返す", async () => {
    listSchoolClassesForAdPlacement.mockResolvedValue([
      { classId: "c1", className: "1組", gradeName: "1年", departmentName: null },
      { classId: "c2", className: "A組", gradeName: "1年", departmentName: "電子工学科" },
    ]);
    const res = await listClassesForSchoolAction(SCHOOL_ID);
    expect(res).toEqual({
      ok: true,
      data: {
        classes: [
          { classId: "c1", label: "1年 1組" },
          { classId: "c2", label: "電子工学科 1年" },
        ],
      },
    });
    expect(requireRoleMock).toHaveBeenCalledWith(["system_admin"]);
  });
});
