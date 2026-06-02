import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createGcsReportDownload } from "../../lib/reports/storage-download";

/**
 * F09 (#430): GCS DL アダプタ `createGcsReportDownload` のユニットテスト。
 *
 * GCS への実アクセスは注入したフェイク Storage で配線を pin する (GCP 認証不要、ADR-012)。Node Readable
 * → Web ReadableStream 変換と not-found (404) → null 写像を検証する。
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

/** バケット内 file のフェイク (getMetadata + createReadStream の最小サーフェス)。 */
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

describe("createGcsReportDownload", () => {
  it("bucket が空なら throw (env REPORT_BUCKET 未設定を弾く)", () => {
    expect(() => createGcsReportDownload({ bucket: "" })).toThrow(/bucket/);
  });

  it("fetch: 指定 path の file を読み、PDF stream + メタを返す", async () => {
    const fs = fakeStorage({
      metadata: { size: "2048", contentType: "application/pdf" },
      content: "%PDF-1.7 hello",
    });
    const port = createGcsReportDownload({ bucket: "kt-reports", storage: fs.storage });
    const result = await port.fetch("reports/2026/05/school-A.pdf");

    expect(fs.bucket).toHaveBeenCalledWith("kt-reports");
    expect(fs.file).toHaveBeenCalledWith("reports/2026/05/school-A.pdf");
    expect(result).not.toBeNull();
    expect(result?.contentType).toBe("application/pdf");
    expect(result?.contentLength).toBe(2048);
    // body は読み出して中身を確認 (Node Readable → Web ReadableStream 変換)。
    // biome-ignore lint/style/noNonNullAssertion: 直前で null でないことを確認済み
    expect(await readAll(result!.body)).toBe("%PDF-1.7 hello");
  });

  it("contentType 不明なら application/pdf にフォールバック", async () => {
    const fs = fakeStorage({ metadata: { size: 10 }, content: "x" });
    const port = createGcsReportDownload({ bucket: "kt-reports", storage: fs.storage });
    const result = await port.fetch("p.pdf");
    expect(result?.contentType).toBe("application/pdf");
    expect(result?.contentLength).toBe(10);
  });

  it("size が非数なら contentLength は undefined", async () => {
    const fs = fakeStorage({ metadata: { contentType: "application/pdf" }, content: "x" });
    const port = createGcsReportDownload({ bucket: "kt-reports", storage: fs.storage });
    const result = await port.fetch("p.pdf");
    expect(result?.contentLength).toBeUndefined();
  });

  it("オブジェクト不在 (code=404) は null に写像 (Route は 404)", async () => {
    const fs = fakeStorage({ metadataError: { code: 404 } });
    const port = createGcsReportDownload({ bucket: "kt-reports", storage: fs.storage });
    expect(await port.fetch("missing.pdf")).toBeNull();
  });

  it("404 以外のエラーは再 throw (障害を隠さない)", async () => {
    const fs = fakeStorage({ metadataError: { code: 500, message: "boom" } });
    const port = createGcsReportDownload({ bucket: "kt-reports", storage: fs.storage });
    await expect(port.fetch("p.pdf")).rejects.toMatchObject({ code: 500 });
  });
});
