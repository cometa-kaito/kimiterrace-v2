import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F02 教員入力 API ルートハンドラの単体テスト。
 *
 * DB は使わず、`lib/db` の `withSession` と `@kimiterrace/db` のドメイン関数をモックして
 * ルートの「認証 → zod 検証 → ドメイン呼び出し → ステータスコード」配線を検証する。
 * RLS / 監査の実挙動は packages/db の RLS テスト + CI 実走 (実 PG) で担保する。
 */

// ---- モック: lib/db ----------------------------------------------------------
// withSession は callback に (tx, user) を渡す契約。テストでは fake tx + teacher user を渡す。
class UnauthenticatedError extends Error {}
const fakeUser = {
  uid: "11111111-1111-1111-1111-111111111111",
  role: "teacher" as const,
  schoolId: "22222222-2222-2222-2222-222222222222",
};
let authed = true;
const withSession = vi.fn(async (fn: (tx: unknown, user: typeof fakeUser) => Promise<unknown>) => {
  if (!authed) throw new UnauthenticatedError();
  return await fn({}, fakeUser);
});

vi.mock("../../lib/db", () => ({
  withSession: (fn: (tx: unknown, user: typeof fakeUser) => Promise<unknown>) => withSession(fn),
  UnauthenticatedError,
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
  it("正常で 201", async () => {
    db.addAttachment.mockResolvedValue({ id: "att-1" });
    const r = new Request("http://localhost", {
      method: "POST",
      body: JSON.stringify({ storagePath: "gs://b/x.pdf", mimeType: "application/pdf" }),
    });
    const res = await attachPOST(r, ctx(VALID_ID));
    expect(res.status).toBe(201);
    expect(db.addAttachment).toHaveBeenCalledWith({}, fakeUser.uid, VALID_ID, {
      storagePath: "gs://b/x.pdf",
      mimeType: "application/pdf",
    });
  });

  it("親 input 不在で 404", async () => {
    db.addAttachment.mockResolvedValue(null);
    const r = new Request("http://localhost", {
      method: "POST",
      body: JSON.stringify({ storagePath: "gs://b/x.pdf", mimeType: "application/pdf" }),
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
});
