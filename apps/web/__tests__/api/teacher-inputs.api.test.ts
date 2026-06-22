import { beforeEach, describe, expect, it, vi } from "vitest";
import { TEACHER_INPUT_STAFF_ROLES, isTeacherInputRole } from "../../lib/teacher-input/roles";

/**
 * F02 教員入力 API ルートハンドラの単体テスト。
 *
 * DB は使わず、`lib/db` の `withSession` と `@kimiterrace/db` のドメイン関数をモックして
 * ルートの「認証 → zod 検証 → ドメイン呼び出し → ステータスコード」配線を検証する。
 * RLS / 監査の実挙動は packages/db の RLS テスト + CI 実走 (実 PG) で担保する。
 */

// ---- モック: lib/db ----------------------------------------------------------
// withSession は callback に (tx, user) を渡す契約。テストでは fake tx + user を渡す。
// 第2引数 `options.allowedRoles` の role 境界 (本物の withSession が強制する) も mock で再現し、
// 非 staff ロール → ForbiddenError → 403 のハンドラ配線を検証する。
class UnauthenticatedError extends Error {}
class ForbiddenError extends Error {}
type FakeUser = { uid: string; role: string; schoolId: string };
const fakeUser = {
  uid: "11111111-1111-1111-1111-111111111111",
  schoolId: "22222222-2222-2222-2222-222222222222",
};
let authed = true;
/** テストごとに上書き可能な現在ロール (beforeEach で "teacher" にリセット)。 */
let currentRole = "teacher";
const withSession = vi.fn(
  async (
    fn: (tx: unknown, user: FakeUser) => Promise<unknown>,
    options?: { allowedRoles?: readonly string[] },
  ) => {
    if (!authed) throw new UnauthenticatedError();
    if (options?.allowedRoles && !options.allowedRoles.includes(currentRole)) {
      throw new ForbiddenError();
    }
    return await fn({}, { ...fakeUser, role: currentRole });
  },
);

vi.mock("../../lib/db", () => ({
  withSession: (
    fn: (tx: unknown, user: FakeUser) => Promise<unknown>,
    options?: { allowedRoles?: readonly string[] },
  ) => withSession(fn, options),
  UnauthenticatedError,
  ForbiddenError,
}));

// ---- モック: @kimiterrace/db ドメイン関数 -----------------------------------
class TeacherInputValidationError extends Error {}
const db = {
  createTeacherInput: vi.fn(),
  listTeacherInputs: vi.fn(),
  getTeacherInput: vi.fn(),
  updateTranscript: vi.fn(),
  saveDraft: vi.fn(),
  submitTeacherInput: vi.fn(),
  deleteTeacherInput: vi.fn(),
  addAttachment: vi.fn(),
  listAttachments: vi.fn(),
};
vi.mock("@kimiterrace/db", () => ({
  ...db,
  TeacherInputValidationError,
}));

// import 対象 (モック後に動的 import)
const { GET: listGET, POST: createPOST } = await import("../../app/api/teacher-inputs/route");
const {
  GET: detailGET,
  PATCH: detailPATCH,
  DELETE: detailDELETE,
} = await import("../../app/api/teacher-inputs/[id]/route");
const { POST: attachPOST } = await import("../../app/api/teacher-inputs/[id]/attachments/route");

const VALID_ID = "33333333-3333-3333-3333-333333333333";
function req(body: unknown): Request {
  return new Request("http://localhost/api/teacher-inputs", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  authed = true;
  currentRole = "teacher";
});

describe("GET /api/teacher-inputs (FR-08 一覧)", () => {
  it("認証済みなら 200 + items", async () => {
    db.listTeacherInputs.mockResolvedValue([{ id: VALID_ID }]);
    const res = await listGET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [{ id: VALID_ID }] });
  });

  it("未認証なら 401", async () => {
    authed = false;
    const res = await listGET();
    expect(res.status).toBe(401);
  });
});

describe("POST /api/teacher-inputs (作成)", () => {
  it("正常な chat 入力で 201", async () => {
    db.createTeacherInput.mockResolvedValue({ id: VALID_ID, inputType: "chat" });
    const res = await createPOST(req({ inputType: "chat", transcript: "明日 10 時集合" }));
    expect(res.status).toBe(201);
    expect(db.createTeacherInput).toHaveBeenCalledWith(
      {},
      fakeUser.schoolId,
      fakeUser.uid,
      expect.objectContaining({ inputType: "chat" }),
    );
  });

  it("inputType 不正で 400 (zod)", async () => {
    const res = await createPOST(req({ inputType: "bogus" }));
    expect(res.status).toBe(400);
    expect(db.createTeacherInput).not.toHaveBeenCalled();
  });

  it("壊れた JSON で 400", async () => {
    const bad = new Request("http://localhost/api/teacher-inputs", {
      method: "POST",
      body: "{not-json",
    });
    const res = await createPOST(bad);
    expect(res.status).toBe(400);
  });

  it("未認証で 401", async () => {
    authed = false;
    const res = await createPOST(req({ inputType: "chat" }));
    expect(res.status).toBe(401);
  });
});

describe("GET /api/teacher-inputs/:id (詳細)", () => {
  it("存在すれば 200", async () => {
    db.getTeacherInput.mockResolvedValue({ id: VALID_ID });
    const res = await detailGET(new Request("http://localhost"), ctx(VALID_ID));
    expect(res.status).toBe(200);
  });

  it("不在なら 404", async () => {
    db.getTeacherInput.mockResolvedValue(null);
    const res = await detailGET(new Request("http://localhost"), ctx(VALID_ID));
    expect(res.status).toBe(404);
  });

  it("不正な id で 400", async () => {
    const res = await detailGET(new Request("http://localhost"), ctx("not-a-uuid"));
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/teacher-inputs/:id (FR-04/06/07)", () => {
  it("edit_transcript: 200 で updateTranscript 呼び出し", async () => {
    db.updateTranscript.mockResolvedValue({ id: VALID_ID, transcriptEdited: true });
    const r = new Request("http://localhost", {
      method: "PATCH",
      body: JSON.stringify({ action: "edit_transcript", transcript: "修正後" }),
    });
    const res = await detailPATCH(r, ctx(VALID_ID));
    expect(res.status).toBe(200);
    expect(db.updateTranscript).toHaveBeenCalledWith({}, fakeUser.uid, VALID_ID, {
      transcript: "修正後",
    });
  });

  it("submit: 200 で submitTeacherInput 呼び出し", async () => {
    db.submitTeacherInput.mockResolvedValue({ id: VALID_ID, status: "submitted" });
    const r = new Request("http://localhost", {
      method: "PATCH",
      body: JSON.stringify({ action: "submit" }),
    });
    const res = await detailPATCH(r, ctx(VALID_ID));
    expect(res.status).toBe(200);
    expect(db.submitTeacherInput).toHaveBeenCalledWith({}, fakeUser.uid, VALID_ID);
  });

  it("submit: transcript 空で 422 (ドメインバリデーション)", async () => {
    db.submitTeacherInput.mockRejectedValue(new TeacherInputValidationError("空"));
    const r = new Request("http://localhost", {
      method: "PATCH",
      body: JSON.stringify({ action: "submit" }),
    });
    const res = await detailPATCH(r, ctx(VALID_ID));
    expect(res.status).toBe(422);
  });

  it("save_draft: submitted 済みで 409", async () => {
    db.saveDraft.mockResolvedValue(null);
    const r = new Request("http://localhost", {
      method: "PATCH",
      body: JSON.stringify({ action: "save_draft", transcript: "x" }),
    });
    const res = await detailPATCH(r, ctx(VALID_ID));
    expect(res.status).toBe(409);
  });

  it("不明な action で 400 (zod discriminated union)", async () => {
    const r = new Request("http://localhost", {
      method: "PATCH",
      body: JSON.stringify({ action: "explode" }),
    });
    const res = await detailPATCH(r, ctx(VALID_ID));
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/teacher-inputs/:id", () => {
  it("削除成功で 200", async () => {
    db.deleteTeacherInput.mockResolvedValue(true);
    const res = await detailDELETE(new Request("http://localhost"), ctx(VALID_ID));
    expect(res.status).toBe(200);
  });

  it("不在なら 404", async () => {
    db.deleteTeacherInput.mockResolvedValue(false);
    const res = await detailDELETE(new Request("http://localhost"), ctx(VALID_ID));
    expect(res.status).toBe(404);
  });
});

describe("POST /api/teacher-inputs/:id/attachments (FR-05 メタ行)", () => {
  // 自校 (fakeUser.schoolId) の per-school upload prefix 内の正当な storagePath。
  const OWN_PATH = `uploads/${fakeUser.schoolId}/att-uuid.pdf`;

  it("正常で 201 (自校 prefix + 許可 MIME)", async () => {
    db.addAttachment.mockResolvedValue({ id: "att-1" });
    const r = new Request("http://localhost", {
      method: "POST",
      body: JSON.stringify({ storagePath: OWN_PATH, mimeType: "application/pdf" }),
    });
    const res = await attachPOST(r, ctx(VALID_ID));
    expect(res.status).toBe(201);
    expect(db.addAttachment).toHaveBeenCalledWith({}, fakeUser.uid, VALID_ID, {
      storagePath: OWN_PATH,
      mimeType: "application/pdf",
    });
  });

  it("親 input 不在で 404", async () => {
    db.addAttachment.mockResolvedValue(null);
    const r = new Request("http://localhost", {
      method: "POST",
      body: JSON.stringify({ storagePath: OWN_PATH, mimeType: "application/pdf" }),
    });
    const res = await attachPOST(r, ctx(VALID_ID));
    expect(res.status).toBe(404);
  });

  it("storagePath 欠落で 400", async () => {
    const r = new Request("http://localhost", {
      method: "POST",
      body: JSON.stringify({ mimeType: "application/pdf" }),
    });
    const res = await attachPOST(r, ctx(VALID_ID));
    expect(res.status).toBe(400);
  });

  it("許可外 MIME で 415、addAttachment 未呼び出し", async () => {
    const r = new Request("http://localhost", {
      method: "POST",
      body: JSON.stringify({ storagePath: OWN_PATH, mimeType: "application/x-msdownload" }),
    });
    const res = await attachPOST(r, ctx(VALID_ID));
    expect(res.status).toBe(415);
    expect(db.addAttachment).not.toHaveBeenCalled();
  });

  it("他校 prefix の storagePath は 403 (越境登録防止)、addAttachment 未呼び出し", async () => {
    const r = new Request("http://localhost", {
      method: "POST",
      body: JSON.stringify({
        storagePath: "uploads/99999999-9999-9999-9999-999999999999/x.pdf",
        mimeType: "application/pdf",
      }),
    });
    const res = await attachPOST(r, ctx(VALID_ID));
    expect(res.status).toBe(403);
    expect(db.addAttachment).not.toHaveBeenCalled();
  });
});

// ---- 認可境界 (High-1): 非 staff ロールは 403 -------------------------------
// teacher_inputs の RLS は school 境界しか守らないため、生徒/保護者の role 境界は
// handler の allowedRoles (→ withSession → ForbiddenError → 403) が第一層で弾く。
describe("認可: 生徒/保護者 (非 staff ロール) は 403 でドメイン未到達", () => {
  it("GET 一覧: student は 403、listTeacherInputs 未呼び出し", async () => {
    currentRole = "student";
    const res = await listGET();
    expect(res.status).toBe(403);
    expect(db.listTeacherInputs).not.toHaveBeenCalled();
  });

  it("POST 作成: student は 403、createTeacherInput 未呼び出し", async () => {
    currentRole = "student";
    const res = await createPOST(req({ inputType: "chat", transcript: "x" }));
    expect(res.status).toBe(403);
    expect(db.createTeacherInput).not.toHaveBeenCalled();
  });

  it("PATCH submit: guardian は 403、submitTeacherInput 未呼び出し", async () => {
    currentRole = "guardian";
    const r = new Request("http://localhost", {
      method: "PATCH",
      body: JSON.stringify({ action: "submit" }),
    });
    const res = await detailPATCH(r, ctx(VALID_ID));
    expect(res.status).toBe(403);
    expect(db.submitTeacherInput).not.toHaveBeenCalled();
  });

  it("DELETE: student は 403、deleteTeacherInput 未呼び出し", async () => {
    currentRole = "student";
    const res = await detailDELETE(new Request("http://localhost"), ctx(VALID_ID));
    expect(res.status).toBe(403);
    expect(db.deleteTeacherInput).not.toHaveBeenCalled();
  });

  it("POST 添付: student は 403、addAttachment 未呼び出し", async () => {
    currentRole = "student";
    const r = new Request("http://localhost", {
      method: "POST",
      body: JSON.stringify({ storagePath: "gs://b/x.pdf", mimeType: "application/pdf" }),
    });
    const res = await attachPOST(r, ctx(VALID_ID));
    expect(res.status).toBe(403);
    expect(db.addAttachment).not.toHaveBeenCalled();
  });

  it("school_admin は許可される (staff ロール)", async () => {
    currentRole = "school_admin";
    db.listTeacherInputs.mockResolvedValue([]);
    const res = await listGET();
    expect(res.status).toBe(200);
    expect(db.listTeacherInputs).toHaveBeenCalled();
  });
});

// ---- pure role モジュール (allowedRoles 定義の単体検証) ----------------------
describe("teacher-input roles (pure)", () => {
  it("teacher / school_admin は staff ロール", () => {
    expect(isTeacherInputRole("teacher")).toBe(true);
    expect(isTeacherInputRole("school_admin")).toBe(true);
  });

  it("student / guardian / system_admin は不可", () => {
    expect(isTeacherInputRole("student")).toBe(false);
    expect(isTeacherInputRole("guardian")).toBe(false);
    expect(isTeacherInputRole("system_admin")).toBe(false);
  });

  it("許可集合は teacher と school_admin のみ", () => {
    expect([...TEACHER_INPUT_STAFF_ROLES].sort()).toEqual(["school_admin", "teacher"]);
  });
});
