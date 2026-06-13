import {
  ContentNotFoundError,
  NoActivePublishError,
  VersionNotFoundError,
  getContentDetail,
  publishContent,
} from "@kimiterrace/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

// next/cache・next/navigation・guard・db を mock。@kimiterrace/db は **部分 mock** (mapDomainError の
// instanceof 判定に実クラスが要るため `...actual` を保持しつつ、PII soft-gate (#426) が呼ぶ
// getContentDetail / publishContent だけを vi.fn 化)。recordPublishDenial は withUserSession mock 越しで
// 呼ばれないので実害なし。guard は requireUser を mock し、純粋関数 isRoleAllowed は実装をそのまま使う。
// redirect は throw する mock にして、認可拒否時に /forbidden へ遷移する (= action が reject する) ことを検証する。
// 正常系の mutation は withSession、拒否時の監査記録は withUserSession (cookie 再検証を避ける、#211 L-1) を使う。
vi.mock("@kimiterrace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@kimiterrace/db")>();
  return { ...actual, getContentDetail: vi.fn(), publishContent: vi.fn() };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
}));
vi.mock("../../lib/auth/guard", () => ({
  requireUser: vi.fn(),
  isRoleAllowed: (role: string, allowed: readonly string[]) => allowed.includes(role),
}));
vi.mock("../../lib/db", () => ({ withSession: vi.fn(), withUserSession: vi.fn() }));

import { redirect } from "next/navigation";
import { requireUser } from "../../lib/auth/guard";
import {
  createContentAction,
  publishContentAction,
  rollbackContentAction,
  unpublishContentAction,
  updateContentAction,
} from "../../lib/contents/publish-actions";
import { mapDomainError, toActor } from "../../lib/contents/publish-core";
import { withSession, withUserSession } from "../../lib/db";

const requireUserMock = vi.mocked(requireUser);
const withSessionMock = vi.mocked(withSession);
const withUserSessionMock = vi.mocked(withUserSession);
const redirectMock = vi.mocked(redirect);
const getContentDetailMock = vi.mocked(getContentDetail);
const publishContentMock = vi.mocked(publishContent);

const CONTENT_ID = "11111111-1111-4111-8111-111111111111";
const SCHOOL_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";

/** getContentDetail の戻り値を body 指定で組む (PII soft-gate は content.body のみ読む)。 */
function detailWithBody(body: string): NonNullable<Awaited<ReturnType<typeof getContentDetail>>> {
  return {
    content: {
      id: CONTENT_ID,
      title: "お知らせ",
      body,
      publishScope: "school",
      status: "draft",
      targets: [],
      updatedAt: new Date(0),
    },
    versions: [],
    activePublish: null,
  };
}

/** withSession の callback を実行する fakeTx。`insert().values()` (監査書込) を記録できる。 */
function makeFakeTx() {
  const inserted: unknown[] = [];
  const tx = {
    insert: () => ({ values: (v: unknown) => inserted.push(v) }),
  };
  // biome-ignore lint/suspicious/noExplicitAny: テスト用の最小 tx スタブ (実 RLS tx は実 PG E2E が担う)。
  return { tx: tx as any, inserted };
}

// 公開系の正常系 actor = publisher（finding⑧ で teacher を PUBLISHER_ROLES から除外したため school_admin）。
const teacher = { uid: USER_ID, role: "school_admin" as const, schoolId: SCHOOL_ID };
/** 自校に属する非 publisher (生徒)。公開系を叩くと拒否され、拒否が監査記録される。 */
const student = { uid: USER_ID, role: "student" as const, schoolId: SCHOOL_ID };

beforeEach(() => {
  vi.clearAllMocks();
  requireUserMock.mockResolvedValue(teacher);
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

describe("createContentAction (#509 S3a)", () => {
  const validInput = { title: "進路だより", body: "本文", publishScope: "class" };

  it("title 空は invalid_input を返し、認証も走らせない", async () => {
    const res = await createContentAction({ ...validInput, title: "" });
    expect(res).toEqual({ ok: false, code: "invalid_input", message: expect.any(String) });
    expect(requireUserMock).not.toHaveBeenCalled();
  });

  it("publishScope 不正は invalid_input を返す", async () => {
    const res = await createContentAction({ ...validInput, publishScope: "galaxy" });
    expect(res).toEqual({ ok: false, code: "invalid_input", message: expect.any(String) });
    expect(requireUserMock).not.toHaveBeenCalled();
  });

  it("正常系: publisher が draft を作成し contentId + version を返す", async () => {
    withSessionMock.mockResolvedValue({ id: "content-new", version: 1 });
    const res = await createContentAction(validInput);
    expect(res).toEqual({ ok: true, data: { contentId: "content-new", version: 1 } });
    expect(requireUserMock).toHaveBeenCalled();
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("非 publisher (生徒) は /forbidden に redirect する", async () => {
    requireUserMock.mockResolvedValue(student);
    await expect(createContentAction(validInput)).rejects.toThrow("REDIRECT:/forbidden");
    expect(redirectMock).toHaveBeenCalledWith("/forbidden");
  });
});

describe("publishContentAction", () => {
  it("不正な contentId は invalid_input を返し、認証も走らせない", async () => {
    const res = await publishContentAction("not-a-uuid");
    expect(res).toEqual({ ok: false, code: "invalid_input", message: expect.any(String) });
    expect(requireUserMock).not.toHaveBeenCalled();
  });

  it("正常系: publisher ロールで公開し、結果を返す (氏名検出なし)", async () => {
    getContentDetailMock.mockResolvedValue(detailWithBody("体育祭は6月10日に開催します。"));
    publishContentMock.mockResolvedValue({ publishId: "pub-1", versionId: "v-1", version: 1 });
    const { tx, inserted } = makeFakeTx();
    withSessionMock.mockImplementation(async (fn) => fn(tx, teacher));
    const res = await publishContentAction(CONTENT_ID);
    expect(res).toEqual({ ok: true, data: { publishId: "pub-1", version: 1 } });
    expect(publishContentMock).toHaveBeenCalledTimes(1);
    // 氏名検出なし → 監査 (PII override) は書かれない。
    expect(inserted).toHaveLength(0);
    expect(requireUserMock).toHaveBeenCalled();
    expect(redirectMock).not.toHaveBeenCalled();
  });

  describe("PII soft-gate (ADR-030, #426)", () => {
    it("本文に氏名らしき表現 (敬称連接) を検出すると pii_warning を返し、公開しない", async () => {
      getContentDetailMock.mockResolvedValue(detailWithBody("田中さんが県大会で優勝しました。"));
      const { tx, inserted } = makeFakeTx();
      withSessionMock.mockImplementation(async (fn) => fn(tx, teacher));
      const res = await publishContentAction(CONTENT_ID);
      expect(res).toMatchObject({ ok: false, code: "pii_warning" });
      if (res.ok) throw new Error("expected pii_warning");
      // 疑わしい表層を投稿者へ提示する。
      expect(res.suspects).toContain("田中さん");
      // hard-block: 実際の公開も監査も走らない。
      expect(publishContentMock).not.toHaveBeenCalled();
      expect(inserted).toHaveLength(0);
    });

    it("acknowledgePii=true (override) なら公開し、override を監査記録する (件数のみ・生氏名は複製しない)", async () => {
      getContentDetailMock.mockResolvedValue(detailWithBody("田中さんが県大会で優勝しました。"));
      publishContentMock.mockResolvedValue({ publishId: "pub-2", versionId: "v-2", version: 3 });
      const { tx, inserted } = makeFakeTx();
      withSessionMock.mockImplementation(async (fn) => fn(tx, teacher));
      const res = await publishContentAction(CONTENT_ID, { acknowledgePii: true });
      expect(res).toEqual({ ok: true, data: { publishId: "pub-2", version: 3 } });
      expect(publishContentMock).toHaveBeenCalledTimes(1);
      // override 監査: contents / update / piiOverride。生の疑わしい氏名は diff に複製しない (ルール4)。
      expect(inserted).toHaveLength(1);
      expect(inserted[0]).toMatchObject({
        tableName: "contents",
        recordId: CONTENT_ID,
        operation: "update",
        actorUserId: USER_ID,
        schoolId: SCHOOL_ID,
        diff: { piiOverride: true, suspectedNameCount: 1 },
      });
      expect(JSON.stringify(inserted[0])).not.toContain("田中");
    });

    it("不可視/不存在 (getContentDetail=null) は not_found、公開しない", async () => {
      getContentDetailMock.mockResolvedValue(null);
      const { tx } = makeFakeTx();
      withSessionMock.mockImplementation(async (fn) => fn(tx, teacher));
      const res = await publishContentAction(CONTENT_ID);
      expect(res).toMatchObject({ ok: false, code: "not_found" });
      expect(publishContentMock).not.toHaveBeenCalled();
    });
  });

  it("非 publisher (生徒) は /forbidden に redirect し、拒否を best-effort 監査記録する (NFR04, #150 L-2)", async () => {
    requireUserMock.mockResolvedValue(student);
    // 認可拒否は redirect("/forbidden") で throw されるため action は reject する。
    await expect(publishContentAction(CONTENT_ID)).rejects.toThrow("REDIRECT:/forbidden");
    expect(redirectMock).toHaveBeenCalledWith("/forbidden");
    // schoolId を持つので拒否監査が試行される (withUserSession 経由で recordPublishDenial、#211 L-1)。
    expect(withUserSessionMock).toHaveBeenCalledTimes(1);
    // 拒否監査は cookie 再検証を避ける withUserSession を使い、通常 mutation 用の withSession は使わない。
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("schoolId 無し (system_admin 等) は /forbidden、監査は記録しない (tenant context 無し)", async () => {
    requireUserMock.mockResolvedValue({ uid: USER_ID, role: "system_admin", schoolId: null });
    await expect(publishContentAction(CONTENT_ID)).rejects.toThrow("REDIRECT:/forbidden");
    expect(redirectMock).toHaveBeenCalledWith("/forbidden");
    // schoolId が無く tenant-scoped audit_log に書けないため記録対象外。
    expect(withUserSessionMock).not.toHaveBeenCalled();
  });

  it("監査記録が失敗しても /forbidden redirect は妨げない (best-effort)", async () => {
    requireUserMock.mockResolvedValue(student);
    withUserSessionMock.mockRejectedValue(new Error("audit write failed"));
    await expect(publishContentAction(CONTENT_ID)).rejects.toThrow("REDIRECT:/forbidden");
    expect(redirectMock).toHaveBeenCalledWith("/forbidden");
  });

  it("防御: publisher role だが schoolId 無し (異常) は forbidden 結果 (toActor null)", async () => {
    // requireUser は通すが normalizeClaims 不変条件外の異常ケース。authorizePublisher は role を
    // 通すが toActor が null になり forbidden 結果を返す (redirect ではなく ActionResult)。publisher role
    // は school_admin（teacher は finding⑧ で除外）— role gate ではなく schoolId 欠落で弾く経路を検証。
    requireUserMock.mockResolvedValue({ uid: USER_ID, role: "school_admin", schoolId: null });
    const res = await publishContentAction(CONTENT_ID);
    expect(res).toMatchObject({ ok: false, code: "forbidden" });
    expect(redirectMock).not.toHaveBeenCalled();
    expect(withSessionMock).not.toHaveBeenCalled();
    expect(withUserSessionMock).not.toHaveBeenCalled();
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
    expect(requireUserMock).not.toHaveBeenCalled();
  });

  it("空文字 title は invalid_input", async () => {
    const res = await updateContentAction(CONTENT_ID, { title: "" });
    expect(res).toMatchObject({ ok: false, code: "invalid_input" });
  });

  it("非文字列 body は invalid_input で、認証も DB も走らせない (#150 L-1)", async () => {
    const res = await updateContentAction(CONTENT_ID, { body: 1 as unknown as string });
    expect(res).toMatchObject({ ok: false, code: "invalid_input" });
    expect(requireUserMock).not.toHaveBeenCalled();
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
