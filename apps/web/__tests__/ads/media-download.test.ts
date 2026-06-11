import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createGcsAdMediaDownload } from "../../lib/ads/media-download";

/**
 * #46 / ADR-037: GCS 広告メディア読取アダプタ `createGcsAdMediaDownload` のユニットテスト。
 * 注入したフェイク Storage で配線を pin する（GCP 認証不要・ADR-012）。Node Readable → Web ReadableStream
 * 変換と not-found(404) → null 写像を検証する（reports の storage-download テストと対の構成）。
 */

/** Web ReadableStream を全量読み出して文字列化する。 */
async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

/** バケット内 file のフェイク（getMetadata + createReadStream の最小サーフェス）。 */
function fakeStorage(opts: {
  metadata?: { size?: string | number; contentType?: string };
  content?: string;
  metadataError?: unknown;
}) {
  const getMetadata = opts.metadataError
    ? vi.fn().mockRejectedValue(opts.metadataError)
    : vi.fn().mockResolvedValue([opts.metadata ?? {}]);
  const createReadStream = vi.fn(() => Readable.from([Buffer.from(opts.content ?? "")]));
  const file = vi.fn(() => ({ getMetadata, createReadStream }));
  const bucket = vi.fn(() => ({ file }));
  return { storage: { bucket } as never, bucket, file, getMetadata, createReadStream };
}

describe("createGcsAdMediaDownload", () => {
  it("bucket が空なら throw（env AD_MEDIA_BUCKET 未設定を弾く）", () => {
    expect(() => createGcsAdMediaDownload({ bucket: "" })).toThrow(/bucket/);
  });

  it("fetch: 指定 key の file を読み、メディア stream + メタを返す", async () => {
    const fs = fakeStorage({
      metadata: { size: "1234", contentType: "image/png" },
      content: "PNGDATA",
    });
    const port = createGcsAdMediaDownload({ bucket: "kt-ad-media", storage: fs.storage });
    const result = await port.fetch("ads/school-a/abc.png");

    expect(fs.bucket).toHaveBeenCalledWith("kt-ad-media");
    expect(fs.file).toHaveBeenCalledWith("ads/school-a/abc.png");
    expect(result).not.toBeNull();
    expect(result?.contentType).toBe("image/png");
    expect(result?.contentLength).toBe(1234);
    // biome-ignore lint/style/noNonNullAssertion: 直前で null でないことを確認済み
    expect(await readAll(result!.body)).toBe("PNGDATA");
  });

  it("contentType 不明なら application/octet-stream にフォールバック", async () => {
    const fs = fakeStorage({ metadata: { size: 10 }, content: "x" });
    const port = createGcsAdMediaDownload({ bucket: "kt-ad-media", storage: fs.storage });
    const result = await port.fetch("ads/x.bin");
    expect(result?.contentType).toBe("application/octet-stream");
    expect(result?.contentLength).toBe(10);
  });

  it("size が非数なら contentLength は undefined", async () => {
    const fs = fakeStorage({ metadata: { contentType: "image/png" }, content: "x" });
    const port = createGcsAdMediaDownload({ bucket: "kt-ad-media", storage: fs.storage });
    const result = await port.fetch("ads/x.png");
    expect(result?.contentLength).toBeUndefined();
  });

  it("オブジェクト不在（code=404）は null に写像（Route は 404）", async () => {
    const fs = fakeStorage({ metadataError: { code: 404 } });
    const port = createGcsAdMediaDownload({ bucket: "kt-ad-media", storage: fs.storage });
    expect(await port.fetch("ads/missing.png")).toBeNull();
  });

  it("404 以外のエラーは再 throw（障害を隠さない）", async () => {
    const fs = fakeStorage({ metadataError: { code: 500, message: "boom" } });
    const port = createGcsAdMediaDownload({ bucket: "kt-ad-media", storage: fs.storage });
    await expect(port.fetch("ads/x.png")).rejects.toMatchObject({ code: 500 });
  });
});
