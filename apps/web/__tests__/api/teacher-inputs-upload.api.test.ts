import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F01 (#509 S2b) ファイルアップロードルート `POST /api/teacher-inputs/upload` の単体テスト。
 *
 * 実 GCS / 実 PG / 実抽出器は使わず、auth (getCurrentUser) / withSession / @kimiterrace/db /
 * @kimiterrace/ai (extractText) / 保存ポートをモックして、ルートの
 * 「認証→role/校ゲート→サイズ→MIME→抽出→保存→DB→ステータス」の配線と、
 * サーバ生成キー (path traversal 不能) を検証する。RLS/監査の実挙動は packages/db RLS テスト + CI 実走で担保。
 */

// ---- モック: lib/auth/session (getCurrentUser) -------------------------------
type FakeUser = { uid: string; role: string; schoolId: string | null };
let currentUser: FakeUser | null = {
  uid: "11111111-1111-1111-1111-111111111111",
  role: "teacher",
  schoolId: "22222222-2222-2222-2222-222222222222",
};
vi.mock("../../lib/auth/session", () => ({
  getCurrentUser: async () => currentUser,
}));

// ---- モック: lib/db (withSession + errors) -----------------------------------
class UnauthenticatedError extends Error {}
class ForbiddenError extends Error {}
const withSession = vi.fn(
  async (
    fn: (tx: unknown, user: FakeUser) => Promise<unknown>,
    options?: { allowedRoles?: readonly string[] },
  ) => {
    if (!currentUser) throw new UnauthenticatedError();
    if (options?.allowedRoles && !options.allowedRoles.includes(currentUser.role)) {
      throw new ForbiddenError();
    }
    return await fn({}, currentUser);
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
const db = {
  createTeacherInput: vi.fn(),
  addAttachment: vi.fn(),
};
vi.mock("@kimiterrace/db", () => ({ ...db }));

// ---- モック: @kimiterrace/ai (extractText + error classes) -------------------
class ExtractorNotConfiguredError extends Error {}
class ExtractFailedError extends Error {}
class UnsupportedFormatError extends Error {}
let extractImpl: () => Promise<{ text: string; format: string }> = async () => ({
  text: "抽出した本文テキスト",
  format: "pdf",
});
vi.mock("@kimiterrace/ai", () => ({
  extractText: () => extractImpl(),
  ExtractorNotConfiguredError,
  ExtractFailedError,
  UnsupportedFormatError,
}));

// ---- モック: 保存ポート (buildUploadObjectPath は実物、getUploadStorage はフェイク) ----
const saved: { path: string; contentType: string; bytes: number }[] = [];
let storageShouldFail = false;
vi.mock("../../lib/storage/upload-storage", async (importActual) => {
  const actual = await importActual<typeof import("../../lib/storage/upload-storage")>();
  return {
    ...actual,
    getUploadStorage: () => ({
      save: async (path: string, body: Buffer, contentType: string) => {
        if (storageShouldFail) throw new Error("gcs unavailable");
        saved.push({ path, contentType, bytes: body.byteLength });
      },
    }),
  };
});

const { POST } = await import("../../app/api/teacher-inputs/upload/route");

const SCHOOL_ID = "22222222-2222-2222-2222-222222222222";

/** route が使う最小 Request fake（headers.get + formData のみ）。 */
function uploadReq(opts: {
  bytes?: number[];
  type?: string;
  name?: string;
  contentLength?: string;
  noFile?: boolean;
  formDataThrows?: boolean;
  size?: number;
}): Request {
  const bytes = new Uint8Array(opts.bytes ?? [1, 2, 3, 4]);
  const file = {
    arrayBuffer: async () => bytes.buffer,
    size: opts.size ?? bytes.byteLength,
    type: opts.type ?? "application/pdf",
    name: opts.name ?? "shinro-dayori.pdf",
  };
  const form = { get: (k: string) => (k === "file" && !opts.noFile ? file : null) };
  return {
    headers: { get: (h: string) => (h === "content-length" ? (opts.contentLength ?? null) : null) },
    formData: async () => {
      if (opts.formDataThrows) throw new Error("not multipart");
      return form as unknown as FormData;
    },
  } as unknown as Request;
}

beforeEach(() => {
  vi.clearAllMocks();
  saved.length = 0;
  storageShouldFail = false;
  currentUser = {
    uid: "11111111-1111-1111-1111-111111111111",
    role: "teacher",
    schoolId: SCHOOL_ID,
  };
  extractImpl = async () => ({ text: "抽出した本文テキスト", format: "pdf" });
  db.createTeacherInput.mockResolvedValue({
    id: "44444444-4444-4444-4444-444444444444",
    inputType: "file",
    status: "ready",
    transcript: "抽出した本文テキスト",
  });
  db.addAttachment.mockResolvedValue({
    id: "55555555-5555-5555-5555-555555555555",
    storagePath: "uploads/x/y.pdf",
    mimeType: "application/pdf",
  });
});

describe("認可（第一層ゲート）", () => {
  it("未認証なら 401（抽出も保存もしない）", async () => {
    currentUser = null;
    const res = await POST(uploadReq({}));
    expect(res.status).toBe(401);
    expect(saved).toHaveLength(0);
    expect(db.createTeacherInput).not.toHaveBeenCalled();
  });

  it("生徒ロールは 403", async () => {
    currentUser = { uid: "u", role: "student", schoolId: SCHOOL_ID };
    const res = await POST(uploadReq({}));
    expect(res.status).toBe(403);
    expect(saved).toHaveLength(0);
  });

  it("所属校なし（system_admin 等）は 403", async () => {
    currentUser = { uid: "u", role: "teacher", schoolId: null };
    const res = await POST(uploadReq({}));
    expect(res.status).toBe(403);
    expect(db.createTeacherInput).not.toHaveBeenCalled();
  });
});

describe("サイズ・MIME 検証", () => {
  it("Content-Length 超過は本体読込前に 413", async () => {
    const res = await POST(uploadReq({ contentLength: String(50 * 1024 * 1024 + 1) }));
    expect(res.status).toBe(413);
    expect(saved).toHaveLength(0);
  });

  it("実バイト長（file.size）超過は 413", async () => {
    const res = await POST(uploadReq({ size: 50 * 1024 * 1024 + 1 }));
    expect(res.status).toBe(413);
  });

  it("file フィールド欠落は 400", async () => {
    const res = await POST(uploadReq({ noFile: true }));
    expect(res.status).toBe(400);
  });

  it("multipart 解析失敗は 400", async () => {
    const res = await POST(uploadReq({ formDataThrows: true }));
    expect(res.status).toBe(400);
  });

  it("許可外 MIME は 415（抽出・保存に到達しない）", async () => {
    const res = await POST(uploadReq({ type: "image/gif" }));
    expect(res.status).toBe(415);
    expect(saved).toHaveLength(0);
    expect(db.createTeacherInput).not.toHaveBeenCalled();
  });
});

describe("正常系（PDF）", () => {
  it("201 + teacher_input(file, ready, transcript) + attachment + GCS 保存", async () => {
    const res = await POST(uploadReq({ type: "application/pdf", name: "x.pdf" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.extraction.status).toBe("extracted");

    expect(db.createTeacherInput).toHaveBeenCalledWith(
      {},
      SCHOOL_ID,
      "11111111-1111-1111-1111-111111111111",
      { inputType: "file", transcript: "抽出した本文テキスト", status: "ready" },
    );
    expect(saved).toHaveLength(1);
    const entry = saved[0];
    if (!entry) throw new Error("no save recorded");
    expect(entry.contentType).toBe("application/pdf");
    // attachment は GCS に保存したのと同じ path を記録
    const attachArgs = db.addAttachment.mock.calls[0];
    if (!attachArgs) throw new Error("addAttachment not called");
    const attachInput = attachArgs[3] as { storagePath: string; mimeType: string };
    expect(attachInput.storagePath).toBe(entry.path);
    expect(attachInput.mimeType).toBe("application/pdf");
  });

  it("保存キーはサーバ生成 UUID + per-school prefix（ファイル名を path に使わない＝traversal 不能）", async () => {
    await POST(uploadReq({ type: "application/pdf", name: "../../../../etc/passwd.pdf" }));
    expect(saved).toHaveLength(1);
    const entry = saved[0];
    if (!entry) throw new Error("no save recorded");
    const path = entry.path;
    expect(path).toMatch(new RegExp(`^uploads/${SCHOOL_ID}/[0-9a-f-]{36}\\.pdf$`));
    expect(path).not.toContain("passwd");
    expect(path).not.toContain("..");
  });
});

describe("画像（OCR 未配線）", () => {
  it("ExtractorNotConfiguredError でも 201・保存はする・transcript 保留 (transcribing)", async () => {
    extractImpl = async () => {
      throw new ExtractorNotConfiguredError("image OCR not wired");
    };
    db.createTeacherInput.mockResolvedValue({
      id: "44444444-4444-4444-4444-444444444444",
      inputType: "file",
      status: "transcribing",
      transcript: null,
    });
    const res = await POST(uploadReq({ type: "image/png", name: "poster.png" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.extraction.status).toBe("pending_ocr");
    expect(db.createTeacherInput).toHaveBeenCalledWith({}, SCHOOL_ID, expect.any(String), {
      inputType: "file",
      transcript: null,
      status: "transcribing",
    });
    expect(saved).toHaveLength(1); // 画像も保存（後で OCR 処理するため）
    const entry = saved[0];
    if (!entry) throw new Error("no save recorded");
    expect(entry.path).toMatch(/\.png$/);
  });
});

describe("抽出失敗・保存失敗", () => {
  it("ExtractFailedError（破損/暗号化）は 422・保存も DB も触らない", async () => {
    extractImpl = async () => {
      throw new ExtractFailedError("corrupt");
    };
    const res = await POST(uploadReq({ type: "application/pdf" }));
    expect(res.status).toBe(422);
    expect(saved).toHaveLength(0);
    expect(db.createTeacherInput).not.toHaveBeenCalled();
  });

  it("GCS 保存失敗は 502・DB 行を作らない（フェイルクローズ）", async () => {
    storageShouldFail = true;
    const res = await POST(uploadReq({ type: "application/pdf" }));
    expect(res.status).toBe(502);
    expect(db.createTeacherInput).not.toHaveBeenCalled();
  });
});
