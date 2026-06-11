import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #46 / ADR-037: 広告メディア配信 Route（`GET /ad-media/<key>`）の単体テスト。
 *
 * GCS は使わず DL ポート（`getAdMediaDownloadPort`）をモックし、Route の
 * 「キー検証 → fetch → 公開キャッシュ stream」配線と、不正キー(400)・不在(404) 写像を検証する。
 * 公開・無認証配信（広告は PII 無しの公開掲示物）ゆえ auth モックは不要。
 */

const fetchObject = vi.fn();
vi.mock("@/lib/ads/media-download-port", () => ({
  getAdMediaDownloadPort: () => ({ fetch: fetchObject }),
}));

const { GET } = await import("../../app/ad-media/[...key]/route");

function mediaStream(text = "PNGDATA"): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function ctx(segments: string[]): { params: Promise<{ key: string[] }> } {
  return { params: Promise.resolve({ key: segments }) };
}

const req = new Request("http://localhost/ad-media/x");

beforeEach(() => {
  vi.clearAllMocks();
  fetchObject.mockResolvedValue({
    body: mediaStream(),
    contentType: "image/png",
    contentLength: 7,
  });
});

describe("GET /ad-media/<key>", () => {
  it("有効なキーは 200 + Content-Type + 長期 immutable キャッシュ + stream", async () => {
    const res = await GET(req, ctx(["ads", "school-a", "abc.png"]));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("Content-Length")).toBe("7");
    expect(fetchObject).toHaveBeenCalledWith("ads/school-a/abc.png");
    expect(await res.text()).toBe("PNGDATA");
  });

  it("接頭辞 ads/ 外のキーは 400（fetch 未到達・汎用プロキシ化を拒否）", async () => {
    const res = await GET(req, ctx(["uploads", "secret.pdf"]));
    expect(res.status).toBe(400);
    expect(fetchObject).not.toHaveBeenCalled();
  });

  it("path traversal（..）は 400（fetch 未到達）", async () => {
    const res = await GET(req, ctx(["ads", "..", "uploads", "secret.pdf"]));
    expect(res.status).toBe(400);
    expect(fetchObject).not.toHaveBeenCalled();
  });

  it("オブジェクト不在は 404", async () => {
    fetchObject.mockResolvedValue(null);
    const res = await GET(req, ctx(["ads", "missing.png"]));
    expect(res.status).toBe(404);
  });

  it("Content-Length 不明なら省略する", async () => {
    fetchObject.mockResolvedValue({
      body: mediaStream(),
      contentType: "image/png",
      contentLength: undefined,
    });
    const res = await GET(req, ctx(["ads", "x.png"]));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Length")).toBeNull();
  });
});
