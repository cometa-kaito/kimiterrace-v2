import { describe, expect, it } from "vitest";
import {
  ALLOWED_UPLOAD_TYPES,
  MAX_REQUEST_BYTES,
  MAX_UPLOAD_BYTES,
  MULTIPART_OVERHEAD_MARGIN,
  RequestTooLargeError,
  exceedsContentLength,
  hasValidImageMagicBytes,
  normalizeMimeType,
  readStreamCapped,
  resolveUploadType,
  uploadErrorMessage,
} from "../../lib/teacher-input/upload-validation";

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];

/** 与えたチャンク列を順に enqueue して閉じる ReadableStream を作る（readStreamCapped 用）。 */
function streamOf(chunks: readonly number[][]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new Uint8Array(chunk));
      }
      controller.close();
    },
  });
}

/**
 * F01 (#509 S2b) アップロード入力検証の単体テスト。
 * MIME allowlist / サイズ上限 / Content-Length 早期棄却の境界を pin する。
 */

describe("MAX_UPLOAD_BYTES", () => {
  it("F01 受け入れ条件 = 50MB", () => {
    expect(MAX_UPLOAD_BYTES).toBe(50 * 1024 * 1024);
  });
});

describe("resolveUploadType", () => {
  it("許可 MIME は拡張子付きで解決（PDF/DOCX/XLSX/PNG/JPEG）", () => {
    expect(resolveUploadType("application/pdf")?.ext).toBe("pdf");
    expect(
      resolveUploadType("application/vnd.openxmlformats-officedocument.wordprocessingml.document")
        ?.ext,
    ).toBe("docx");
    expect(
      resolveUploadType("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")?.ext,
    ).toBe("xlsx");
    expect(resolveUploadType("image/png")?.ext).toBe("png");
    expect(resolveUploadType("image/jpeg")?.ext).toBe("jpg");
  });

  it("charset パラメータ・大小・前後空白を正規化して照合", () => {
    expect(resolveUploadType("application/pdf; charset=binary")?.ext).toBe("pdf");
    expect(resolveUploadType("  IMAGE/PNG  ")?.ext).toBe("png");
  });

  it("許可外 MIME は null（レガシー Office / 実行可能 / スクリプト等を拒否）", () => {
    expect(resolveUploadType("application/msword")).toBeNull(); // .doc
    expect(resolveUploadType("application/vnd.ms-excel")).toBeNull(); // .xls
    expect(resolveUploadType("application/x-msdownload")).toBeNull(); // .exe
    expect(resolveUploadType("text/html")).toBeNull();
    expect(resolveUploadType("application/zip")).toBeNull();
  });

  it("空・未指定は null", () => {
    expect(resolveUploadType(null)).toBeNull();
    expect(resolveUploadType(undefined)).toBeNull();
    expect(resolveUploadType("")).toBeNull();
  });

  it("拡張子は MIME 由来であり全許可種別に存在する（path はファイル名非依存）", () => {
    for (const t of ALLOWED_UPLOAD_TYPES) {
      expect(t.ext).toMatch(/^[a-z0-9]+$/);
      expect(t.ext.includes(".")).toBe(false);
      expect(t.ext.includes("/")).toBe(false);
    }
  });
});

describe("exceedsContentLength", () => {
  it("上限超過の Content-Length は true", () => {
    expect(exceedsContentLength(String(MAX_UPLOAD_BYTES + 1))).toBe(true);
  });
  it("上限ちょうど・以下は false", () => {
    expect(exceedsContentLength(String(MAX_UPLOAD_BYTES))).toBe(false);
    expect(exceedsContentLength("1024")).toBe(false);
  });
  it("未指定・解析不能は false（実バイト長で再検査するため）", () => {
    expect(exceedsContentLength(null)).toBe(false);
    expect(exceedsContentLength(undefined)).toBe(false);
    expect(exceedsContentLength("not-a-number")).toBe(false);
  });
});

describe("normalizeMimeType", () => {
  it("charset パラメータ・大小・前後空白を本体だけに正規化", () => {
    expect(normalizeMimeType("application/pdf; charset=binary")).toBe("application/pdf");
    expect(normalizeMimeType("  IMAGE/PNG  ")).toBe("image/png");
  });
  it("空・未指定は空文字", () => {
    expect(normalizeMimeType(null)).toBe("");
    expect(normalizeMimeType(undefined)).toBe("");
    expect(normalizeMimeType("")).toBe("");
  });
});

describe("MAX_REQUEST_BYTES (#522 M-1)", () => {
  it("= 本体上限 50MB + multipart 余白 1MB", () => {
    expect(MULTIPART_OVERHEAD_MARGIN).toBe(1024 * 1024);
    expect(MAX_REQUEST_BYTES).toBe(MAX_UPLOAD_BYTES + 1024 * 1024);
  });
});

describe("readStreamCapped (#522 M-1)", () => {
  it("上限内のストリームはチャンクを連結して返す", async () => {
    const out = await readStreamCapped(
      streamOf([
        [1, 2],
        [3, 4, 5],
      ]),
      10,
    );
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5]);
  });

  it("累積バイトが上限超過で RequestTooLargeError（全部はバッファしない）", async () => {
    await expect(
      readStreamCapped(
        streamOf([
          [1, 2, 3],
          [4, 5, 6],
        ]),
        5,
      ),
    ).rejects.toBeInstanceOf(RequestTooLargeError);
  });

  it("上限ちょうどは許容（境界）", async () => {
    const out = await readStreamCapped(streamOf([[1, 2, 3, 4, 5]]), 5);
    expect(out.byteLength).toBe(5);
  });

  it("null / undefined body は空配列", async () => {
    expect((await readStreamCapped(null, 10)).byteLength).toBe(0);
    expect((await readStreamCapped(undefined, 10)).byteLength).toBe(0);
  });
});

describe("hasValidImageMagicBytes (#522 L-2)", () => {
  it("正しい PNG / JPEG 署名は true", () => {
    expect(hasValidImageMagicBytes(new Uint8Array([...PNG_MAGIC, 0, 0]), "image/png")).toBe(true);
    expect(hasValidImageMagicBytes(new Uint8Array([...JPEG_MAGIC, 0, 0]), "image/jpeg")).toBe(true);
  });

  it("画像 MIME だが署名不一致は false（MIME 偽装の画像を拒否）", () => {
    expect(hasValidImageMagicBytes(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), "image/png")).toBe(
      false,
    );
    expect(hasValidImageMagicBytes(new Uint8Array([0xff, 0x00, 0x00]), "image/jpeg")).toBe(false);
  });

  it("署名より短いバッファは false", () => {
    expect(hasValidImageMagicBytes(new Uint8Array([0x89, 0x50]), "image/png")).toBe(false);
  });

  it("非画像 MIME（PDF/Office/空）は検査対象外で true", () => {
    expect(hasValidImageMagicBytes(new Uint8Array([1, 2, 3]), "application/pdf")).toBe(true);
    expect(hasValidImageMagicBytes(new Uint8Array([1, 2, 3]), null)).toBe(true);
  });

  it("charset パラメータ付き image MIME も正規化して検査", () => {
    expect(hasValidImageMagicBytes(new Uint8Array(PNG_MAGIC), "image/png; charset=binary")).toBe(
      true,
    );
  });
});

describe("uploadErrorMessage (#509 S3b)", () => {
  it("主要ステータスを日本語メッセージに写像する", () => {
    expect(uploadErrorMessage(413)).toContain("50MB");
    expect(uploadErrorMessage(415)).toContain("対応していない");
    expect(uploadErrorMessage(422)).toContain("読み取れません");
    expect(uploadErrorMessage(401)).toContain("ログイン");
    expect(uploadErrorMessage(403)).toContain("権限");
    expect(uploadErrorMessage(502)).toContain("保存");
  });
  it("想定外ステータスは汎用文言にフォールバック", () => {
    expect(uploadErrorMessage(500)).toBe("アップロードに失敗しました。");
  });
});
