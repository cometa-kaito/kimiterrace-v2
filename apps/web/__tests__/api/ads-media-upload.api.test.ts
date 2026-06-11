import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #46 / ADR-037: 広告メディアアップロード Route（`POST /api/ads/media`）の単体テスト。
 *
 * 実 GCS は使わず getCurrentUser / ad-media 保存ポートをモックし、ルートの
 * 「認証 → ADS_ROLES/校ゲート → サイズ → MIME → マジックバイト → 保存 → 配信 URL 返却」配線と、
 * サーバ生成キー（per-school prefix・path traversal 不能）を検証する。
 */

// ---- モック: lib/auth/session (getCurrentUser) -------------------------------
type FakeUser = { uid: string; role: string; schoolId: string | null };
const SCHOOL_ID = "22222222-2222-2222-2222-222222222222";
let currentUser: FakeUser | null = {
  uid: "11111111-1111-1111-1111-111111111111",
  role: "school_admin",
  schoolId: SCHOOL_ID,
};
vi.mock("@/lib/auth/session", () => ({
  getCurrentUser: async () => currentUser,
}));

// ---- モック: ADS_ROLES（重い barrel import を避け定数だけ差し替え） --------------
vi.mock("@/lib/school-admin/ads-core", () => ({
  ADS_ROLES: ["school_admin", "system_admin"] as const,
}));

// ---- モック: ad-media 保存ポート ---------------------------------------------
const saved: { key: string; contentType: string; bytes: number }[] = [];
let storageShouldFail = false;
vi.mock("@/lib/ads/media-upload-storage", () => ({
  getAdMediaUploadStorage: () => ({
    save: async (key: string, body: Buffer, contentType: string) => {
      if (storageShouldFail) throw new Error("gcs unavailable");
      saved.push({ key, contentType, bytes: body.byteLength });
    },
  }),
}));

const { POST } = await import("../../app/api/ads/media/route");

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];

/** route が使う最小 Request fake（headers.get + formData のみ。body 無し → formData フォールバック）。 */
function uploadReq(opts: {
  bytes?: number[];
  type?: string;
  name?: string;
  contentLength?: string;
  noFile?: boolean;
  size?: number;
}): Request {
  const bytes = new Uint8Array(opts.bytes ?? PNG_MAGIC);
  const file = {
    arrayBuffer: async () => bytes.buffer,
    size: opts.size ?? bytes.byteLength,
    type: opts.type ?? "image/png",
    name: opts.name ?? "ad.png",
  };
  const form = { get: (k: string) => (k === "file" && !opts.noFile ? file : null) };
  return {
    headers: { get: (h: string) => (h === "content-length" ? (opts.contentLength ?? null) : null) },
    formData: async () => form as unknown as FormData,
  } as unknown as Request;
}

beforeEach(() => {
  vi.clearAllMocks();
  saved.length = 0;
  storageShouldFail = false;
  currentUser = {
    uid: "11111111-1111-1111-1111-111111111111",
    role: "school_admin",
    schoolId: SCHOOL_ID,
  };
});

describe("認可（第一層ゲート）", () => {
  it("未認証なら 401（保存しない）", async () => {
    currentUser = null;
    const res = await POST(uploadReq({}));
    expect(res.status).toBe(401);
    expect(saved).toHaveLength(0);
  });

  it("teacher は 403（広告 = 収益コンテンツは編集不可）", async () => {
    currentUser = { uid: "u", role: "teacher", schoolId: SCHOOL_ID };
    const res = await POST(uploadReq({}));
    expect(res.status).toBe(403);
    expect(saved).toHaveLength(0);
  });

  it("student は 403", async () => {
    currentUser = { uid: "u", role: "student", schoolId: SCHOOL_ID };
    const res = await POST(uploadReq({}));
    expect(res.status).toBe(403);
  });

  it("所属校なし（テナント未選択 system_admin）は 403", async () => {
    currentUser = { uid: "u", role: "system_admin", schoolId: null };
    const res = await POST(uploadReq({}));
    expect(res.status).toBe(403);
    expect(saved).toHaveLength(0);
  });

  it("system_admin（校選択済）は許可", async () => {
    currentUser = { uid: "u", role: "system_admin", schoolId: SCHOOL_ID };
    const res = await POST(uploadReq({}));
    expect(res.status).toBe(201);
  });
});

describe("検証", () => {
  it("Content-Length 超過は 413（本体読込前に棄却）", async () => {
    const res = await POST(uploadReq({ contentLength: String(60 * 1024 * 1024) }));
    expect(res.status).toBe(413);
    expect(saved).toHaveLength(0);
  });

  it("file 欠落は 400", async () => {
    const res = await POST(uploadReq({ noFile: true }));
    expect(res.status).toBe(400);
  });

  it("許可外 MIME（gif / pdf / mp4）は 415", async () => {
    for (const type of ["image/gif", "application/pdf", "video/mp4"]) {
      const res = await POST(uploadReq({ type }));
      expect(res.status).toBe(415);
    }
    expect(saved).toHaveLength(0);
  });

  it("実バイト長が上限超過は 413", async () => {
    const res = await POST(uploadReq({ size: 60 * 1024 * 1024 }));
    expect(res.status).toBe(413);
  });

  it("宣言 image だが実バイトがマジックバイト不一致なら 415（偽装画像を弾く）", async () => {
    const res = await POST(uploadReq({ type: "image/png", bytes: [0x00, 0x01, 0x02, 0x03] }));
    expect(res.status).toBe(415);
    expect(saved).toHaveLength(0);
  });
});

describe("保存と返却", () => {
  it("PNG 成功: 201 + 配信 URL（/ad-media/ads/<schoolId>/<uuid>.png）+ mediaType=image", async () => {
    const res = await POST(uploadReq({ type: "image/png", bytes: PNG_MAGIC }));
    expect(res.status).toBe(201);
    const json = (await res.json()) as { url: string; mediaType: string };
    expect(json.mediaType).toBe("image");
    expect(json.url).toMatch(new RegExp(`^/ad-media/ads/${SCHOOL_ID}/[0-9a-f-]{36}\\.png$`));
    // 保存キーは配信 URL と一致（先頭 /ad-media/ を除いたもの）+ per-school prefix。
    expect(saved).toHaveLength(1);
    expect(saved[0]?.key).toBe(json.url.replace("/ad-media/", ""));
    expect(saved[0]?.contentType).toBe("image/png");
  });

  it("JPEG 成功: ext は jpg", async () => {
    const res = await POST(uploadReq({ type: "image/jpeg", bytes: JPEG_MAGIC }));
    expect(res.status).toBe(201);
    const json = (await res.json()) as { url: string };
    expect(json.url).toMatch(/\.jpg$/);
  });

  it("保存失敗は 502（フェイルクローズ・URL を返さない）", async () => {
    storageShouldFail = true;
    const res = await POST(uploadReq({ type: "image/png", bytes: PNG_MAGIC }));
    expect(res.status).toBe(502);
  });
});
