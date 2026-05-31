import { ContentNotFoundError, NoActivePublishError, VersionNotFoundError } from "@kimiterrace/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

// next/cache・guard・db を mock。@kimiterrace/db は **mock しない** (mapDomainError の
// instanceof 判定に実クラスが要るため)。service 関数は withSession を mock するので実行されない。
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../../lib/auth/guard", () => ({ requireRole: vi.fn() }));
vi.mock("../../lib/db", () => ({ withSession: vi.fn() }));

import { requireRole } from "../../lib/auth/guard";
import {
  publishContentAction,
  rollbackContentAction,
  unpublishContentAction,
  updateContentAction,
} from "../../lib/contents/publish-actions";
import { mapDomainError, toActor } from "../../lib/contents/publish-core";
import { withSession } from "../../lib/db";

const requireRoleMock = vi.mocked(requireRole);
const withSessionMock = vi.mocked(withSession);

const CONTENT_ID = "11111111-1111-4111-8111-111111111111";
const SCHOOL_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";

const teacher = { uid: USER_ID, role: "teacher" as const, schoolId: SCHOOL_ID };

beforeEach(() => {
  vi.clearAllMocks();
  requireRoleMock.mockResolvedValue(teacher);
});

describe("toActor", () => {
  it("schoolId があれば actor を返す", () => {
    expect(toActor(teacher)).toEqual({ userId: USER_ID, schoolId: SCHOOL_ID });
  });
  it("schoolId が null なら null (system_admin / 異常)", () => {
    expect(toActor({ uid: USER_ID, role: "system_admin", schoolId: null })).toBeNull();
  });
});

describe("mapDomainError", () => {
  it("ContentNotFoundError → not_found", () => {
    expect(mapDomainError(new ContentNotFoundError("x")).code).toBe("not_found");
  });
  it("NoActivePublishError → no_active_publish", () => {
    expect(mapDomainError(new NoActivePublishError("x")).code).toBe("no_active_publish");
  });
  it("VersionNotFoundError → version_not_found", () => {
    expect(mapDomainError(new VersionNotFoundError("x", 1)).code).toBe("version_not_found");
  });
  it("想定外の例外は握りつぶさず再 throw する", () => {
    expect(() => mapDomainError(new Error("boom"))).toThrow("boom");
  });
});

describe("publishContentAction", () => {
  it("不正な contentId は invalid_input を返し、認可も走らせない", async () => {
    const res = await publishContentAction("not-a-uuid");
    expect(res).toEqual({ ok: false, code: "invalid_input", message: expect.any(String) });
    expect(requireRoleMock).not.toHaveBeenCalled();
  });

  it("正常系: publisher ロールで公開し、結果を返す", async () => {
    withSessionMock.mockResolvedValue({ publishId: "pub-1", versionId: "v-1", version: 1 });
    const res = await publishContentAction(CONTENT_ID);
    expect(res).toEqual({ ok: true, data: { publishId: "pub-1", version: 1 } });
    // publisher ロールのみ許可
    expect(requireRoleMock).toHaveBeenCalledWith(["school_admin", "teacher"]);
  });

  it("schoolId 無し (system_admin 等) は forbidden", async () => {
    requireRoleMock.mockResolvedValue({ uid: USER_ID, role: "system_admin", schoolId: null });
    const res = await publishContentAction(CONTENT_ID);
    expect(res).toMatchObject({ ok: false, code: "forbidden" });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("ドメイン例外 (ContentNotFoundError) は not_found 結果に変換", async () => {
    withSessionMock.mockRejectedValue(new ContentNotFoundError(CONTENT_ID));
    const res = await publishContentAction(CONTENT_ID);
    expect(res).toMatchObject({ ok: false, code: "not_found" });
  });
});

describe("updateContentAction", () => {
  it("不正な publishScope は invalid_input", async () => {
    const res = await updateContentAction(CONTENT_ID, { publishScope: "everyone" });
    expect(res).toMatchObject({ ok: false, code: "invalid_input" });
    expect(requireRoleMock).not.toHaveBeenCalled();
  });

  it("空文字 title は invalid_input", async () => {
    const res = await updateContentAction(CONTENT_ID, { title: "" });
    expect(res).toMatchObject({ ok: false, code: "invalid_input" });
  });

  it("非文字列 body は invalid_input で、認可も DB も走らせない (#150 L-1)", async () => {
    const res = await updateContentAction(CONTENT_ID, { body: 1 as unknown as string });
    expect(res).toMatchObject({ ok: false, code: "invalid_input" });
    expect(requireRoleMock).not.toHaveBeenCalled();
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("非配列 targets は invalid_input (#150 L-1)", async () => {
    const res = await updateContentAction(CONTENT_ID, { targets: { classId: "x" } });
    expect(res).toMatchObject({ ok: false, code: "invalid_input" });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("正常系: 許可スコープで更新し version を返す", async () => {
    withSessionMock.mockResolvedValue({ version: 2 });
    const res = await updateContentAction(CONTENT_ID, { body: "改訂", publishScope: "class" });
    expect(res).toEqual({ ok: true, data: { version: 2 } });
  });
});

describe("unpublishContentAction", () => {
  it("公開中が無ければ no_active_publish に変換", async () => {
    withSessionMock.mockRejectedValue(new NoActivePublishError(CONTENT_ID));
    const res = await unpublishContentAction(CONTENT_ID);
    expect(res).toMatchObject({ ok: false, code: "no_active_publish" });
  });

  it("正常系", async () => {
    withSessionMock.mockResolvedValue({ publishId: "pub-9" });
    const res = await unpublishContentAction(CONTENT_ID);
    expect(res).toEqual({ ok: true, data: { publishId: "pub-9" } });
  });
});

describe("rollbackContentAction", () => {
  it("targetVersion < 1 は invalid_input", async () => {
    const res = await rollbackContentAction(CONTENT_ID, 0);
    expect(res).toMatchObject({ ok: false, code: "invalid_input" });
  });

  it("非整数 targetVersion は invalid_input", async () => {
    const res = await rollbackContentAction(CONTENT_ID, 1.5);
    expect(res).toMatchObject({ ok: false, code: "invalid_input" });
  });

  it("存在しないバージョンは version_not_found に変換", async () => {
    withSessionMock.mockRejectedValue(new VersionNotFoundError(CONTENT_ID, 99));
    const res = await rollbackContentAction(CONTENT_ID, 99);
    expect(res).toMatchObject({ ok: false, code: "version_not_found" });
  });

  it("正常系: 復元結果を返す", async () => {
    withSessionMock.mockResolvedValue({ version: 3, restoredFrom: 1 });
    const res = await rollbackContentAction(CONTENT_ID, 1);
    expect(res).toEqual({ ok: true, data: { version: 3, restoredFrom: 1 } });
  });
});
