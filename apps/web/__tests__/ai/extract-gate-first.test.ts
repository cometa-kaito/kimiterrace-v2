import type { ModelClient, RateLimiter } from "@kimiterrace/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "../../lib/auth/session";

/**
 * F03 (#38 / #243, PR #463 Reviewer Med-1): **gate-first 順序を縛る回帰テスト**。
 *
 * PR #463 は教員入力 AI 抽出経路の role ゲート（{@link getAuthorizedExtractionUser}）を、
 * (a) transcript（生徒文脈の自由記述を含みうる PII）ロード、(b) 職員氏名 roster（PII）ロード、
 * (c) Vertex 消費の **いずれより前** に発火させた（`defaultLoadTranscript` / `defaultLoadStaffPiiEntries`
 * の冒頭で `await getAuthorizedExtractionUser()`）。
 *
 * 既存テストは {@link getAuthorizedExtractionUser} ヘルパ単体（run-extraction.test.ts）と、loaders を
 * **注入** したオーケストレーション（extract-teacher-input.test.ts）しか突いていない。よって本体の
 * **既定 loaders** が「ゲート → DB 読取」の順で並んでいることを縛る回帰テストが無く、将来 "read-first,
 * gate-later" に reorder されても CI が検知できない（= 脆弱性の silent 再導入）。
 *
 * 本テストは route と同じく `extractTeacherInput(inputId, kind)` を **deps 無し（= defaultDeps）** で駆動し、
 * 既定 loaders を実走させる。`getCurrentUser` を非作者 role（student / guardian）にし、下層 DB 読取
 * （`getTeacherInput` / `listStaffDisplayNames`）を spy 化して **一切呼ばれない** ことを断言する。
 * これにより、誰かが loaders を「読取 → ゲート」に並べ替えると本テストが**必ず失敗**する。
 *
 * 決定論: 実 Vertex / 実 DB 不使用（純 mock/spy）。実 Vertex model 生成（`createVertexModelClient`）も
 * stub し、`defaultDeps` 構築時に外部依存を踏まないようにする。エラークラスは instanceof 成立のため
 * `lib/db` 側を test 用クラスで差し替える（既存 extract-teacher-input.test.ts と同規律）。
 */

const mocks = vi.hoisted(() => {
  class UnauthenticatedError extends Error {}
  class ForbiddenError extends Error {}
  return {
    getCurrentUser: vi.fn<() => Promise<AuthUser | null>>(),
    // withUserSession は (user, fn) を fake tx で実行する pass-through。
    // gate が先に throw すれば、本体の既定 loader はここに到達しない。
    withUserSession: vi.fn(async (_user: unknown, fn: (tx: unknown) => Promise<unknown>) =>
      fn({ __fakeTx: true }),
    ),
    getTeacherInput: vi.fn(async (_tx: unknown, _id: string) => ({
      transcript: "1限 数学、2限 英語",
    })),
    listStaffDisplayNames: vi.fn(async (_tx: unknown) => ["田中先生", "佐藤教頭"]),
    UnauthenticatedError,
    ForbiddenError,
  };
});

vi.mock("../../lib/auth/session", () => ({ getCurrentUser: () => mocks.getCurrentUser() }));
vi.mock("../../lib/db", () => ({
  withUserSession: (u: unknown, fn: (tx: unknown) => Promise<unknown>) =>
    mocks.withUserSession(u, fn),
  UnauthenticatedError: mocks.UnauthenticatedError,
  ForbiddenError: mocks.ForbiddenError,
}));
// 既定 loaders が叩く下層 DB 読取を spy 化（gate-first なら非到達）。
vi.mock("@kimiterrace/db", () => ({
  getTeacherInput: (tx: unknown, id: string) => mocks.getTeacherInput(tx, id),
  listStaffDisplayNames: (tx: unknown) => mocks.listStaffDisplayNames(tx),
}));
// 実 Vertex 生成と rate limiter は本テストの主題外。defaultDeps 構築で外部依存を踏まないよう stub
// （エラークラス PiiLeakError / RateLimitExceededError 等は actual を温存して instanceof を壊さない）。
vi.mock("@kimiterrace/ai", async () => {
  const actual = await vi.importActual<typeof import("@kimiterrace/ai")>("@kimiterrace/ai");
  const stubModel: ModelClient = {
    generate: vi.fn(async () => {
      throw new Error("model.generate must not be reached for a forbidden role");
    }),
  };
  const stubRateLimiter: RateLimiter = { tryAcquire: () => true };
  return {
    ...actual,
    createVertexModelClient: vi.fn(() => stubModel),
    createPerSchoolRateLimiter: vi.fn(() => stubRateLimiter),
  };
});

import { extractTeacherInput } from "../../lib/ai/extract-teacher-input";

const SCHOOL_ID = "22222222-2222-2222-2222-222222222222";
const TEACHER: AuthUser = {
  uid: "11111111-1111-1111-1111-111111111111",
  role: "teacher",
  schoolId: SCHOOL_ID,
};

afterEach(() => {
  mocks.getCurrentUser.mockReset();
  mocks.withUserSession.mockClear();
  mocks.getTeacherInput.mockClear();
  mocks.listStaffDisplayNames.mockClear();
});

describe("extractTeacherInput gate-first 順序の回帰ロック (#463 Med-1)", () => {
  // 非作者 role は EXTRACTION_AUTHOR_ROLES (teacher / school_admin) 以外。代表として student / guardian。
  it.each([
    "student",
    "guardian",
  ] as const)("非作者 role=%s: forbidden に畳み、transcript/職員roster の DB 読取に到達しない", async (role) => {
    mocks.getCurrentUser.mockResolvedValue({ ...TEACHER, role });

    // route と同じ呼び出し形（deps 無し = defaultDeps、既定 loaders を実走）。
    const res = await extractTeacherInput("input-1", "schedule");

    expect(res).toEqual({ ok: false, reason: "forbidden" });
    // gate-first の核心: 非作者なら下層 PII 読取は一切走らない。
    // load-before-gate に reorder されると、この 2 つの断言が必ず失敗する。
    expect(mocks.getTeacherInput).not.toHaveBeenCalled();
    expect(mocks.listStaffDisplayNames).not.toHaveBeenCalled();
  });

  it("未認証も forbidden 同様に DB 読取へ到達しない（unauthenticated に畳む）", async () => {
    mocks.getCurrentUser.mockResolvedValue(null);

    const res = await extractTeacherInput("input-1", "schedule");

    expect(res).toEqual({ ok: false, reason: "unauthenticated" });
    expect(mocks.getTeacherInput).not.toHaveBeenCalled();
    expect(mocks.listStaffDisplayNames).not.toHaveBeenCalled();
  });

  // 正常系の対照: 認可 role では既定 loaders が DB 読取に到達する。これが無いと「誰も loader を
  // 呼ばないから forbidden ケースが通る」vacuous な合格になりうる（gate の前後関係を実証できない）。
  it("認可 role=teacher: 既定 loaders が transcript と職員roster の DB 読取に到達する（対照）", async () => {
    mocks.getCurrentUser.mockResolvedValue(TEACHER);

    const res = await extractTeacherInput("input-1", "schedule");

    // model.generate は stub が throw するため抽出本体は失敗するが、loaders が DB 読取に達したことが要点。
    // （forbidden ケースとの対照: 読取に到達する経路が現に存在することを示し vacuous 合格を防ぐ。）
    expect(res.ok).toBe(false);
    expect(mocks.getTeacherInput).toHaveBeenCalledWith({ __fakeTx: true }, "input-1");
    expect(mocks.listStaffDisplayNames).toHaveBeenCalledWith({ __fakeTx: true });
  });
});
