import { describe, expect, it } from "vitest";
import {
  ALLOWED_UPLOAD_TYPES,
  MAX_UPLOAD_BYTES,
  exceedsContentLength,
  resolveUploadType,
} from "../../lib/teacher-input/upload-validation";

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
