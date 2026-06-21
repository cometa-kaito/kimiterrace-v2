import { describe, expect, it, vi } from "vitest";
import {
  buildUploadObjectPath,
  createGcsUploadStorage,
  isWithinSchoolUploadPrefix,
} from "../../lib/storage/upload-storage";

/**
 * F01 (#509 S2b) アップロード保存ポートの単体テスト。
 * per-school prefix の path 規約と、GCS アダプタの保存配線（フェイク client 注入）を検証する。
 */

describe("buildUploadObjectPath", () => {
  it("uploads/{schoolId}/{objectId}.{ext} を組み立てる（per-school prefix）", () => {
    expect(buildUploadObjectPath("school-1", "obj-uuid", "pdf")).toBe(
      "uploads/school-1/obj-uuid.pdf",
    );
  });

  it("schoolId を第1階層に置きテナント prefix 境界を作る", () => {
    const path = buildUploadObjectPath("aaaaaaaa-bbbb", "cccc", "png");
    expect(path.startsWith("uploads/aaaaaaaa-bbbb/")).toBe(true);
  });

  it("schoolId / objectId / ext の区切り文字混入を弾く（path injection 防止）", () => {
    expect(() => buildUploadObjectPath("a/b", "obj", "pdf")).toThrow(RangeError);
    expect(() => buildUploadObjectPath("school", "../etc/passwd", "pdf")).toThrow(RangeError);
    expect(() => buildUploadObjectPath("school", "obj", "p/df")).toThrow(RangeError);
    expect(() => buildUploadObjectPath("school", "obj", "pdf.exe")).toThrow(RangeError);
  });

  it("空入力を弾く", () => {
    expect(() => buildUploadObjectPath("", "obj", "pdf")).toThrow(RangeError);
    expect(() => buildUploadObjectPath("school", "", "pdf")).toThrow(RangeError);
    expect(() => buildUploadObjectPath("school", "obj", "")).toThrow(RangeError);
  });
});

describe("isWithinSchoolUploadPrefix（越境登録防止）", () => {
  const SCHOOL = "22222222-2222-2222-2222-222222222222";

  it("自校 prefix 内の path は許可", () => {
    expect(isWithinSchoolUploadPrefix(`uploads/${SCHOOL}/obj.pdf`, SCHOOL)).toBe(true);
  });

  it("他校 prefix の path は拒否（cross-tenant 登録を構造的に塞ぐ）", () => {
    const other = "33333333-3333-3333-3333-333333333333";
    expect(isWithinSchoolUploadPrefix(`uploads/${other}/obj.pdf`, SCHOOL)).toBe(false);
  });

  it("prefix を持たない / 別ルートの path は拒否", () => {
    expect(isWithinSchoolUploadPrefix("gs://b/x.pdf", SCHOOL)).toBe(false);
    expect(isWithinSchoolUploadPrefix(`reports/${SCHOOL}/x.pdf`, SCHOOL)).toBe(false);
  });

  it(".. 混入は拒否（path traversal）", () => {
    expect(isWithinSchoolUploadPrefix(`uploads/${SCHOOL}/../../etc/x`, SCHOOL)).toBe(false);
  });

  it("schoolId 空 / 区切り文字混入は拒否（テナント文脈なし・injection）", () => {
    expect(isWithinSchoolUploadPrefix(`uploads/${SCHOOL}/obj.pdf`, "")).toBe(false);
    expect(isWithinSchoolUploadPrefix(`uploads/${SCHOOL}/obj.pdf`, null)).toBe(false);
    expect(isWithinSchoolUploadPrefix("uploads/a/b/obj.pdf", "a/b")).toBe(false);
  });
});

describe("createGcsUploadStorage", () => {
  it("バケット名が空なら明示エラー（ルール5: env 注入必須）", () => {
    expect(() => createGcsUploadStorage({ bucket: "" })).toThrow(/UPLOAD_BUCKET/);
  });

  it("save は指定 path・Content-Type・非 resumable で file.save を呼ぶ", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const file = vi.fn().mockReturnValue({ save });
    const bucket = vi.fn().mockReturnValue({ file });
    // @google-cloud/storage の Storage を duck-type で注入
    const fakeStorage = { bucket } as unknown as import("@google-cloud/storage").Storage;

    const port = createGcsUploadStorage({ bucket: "test-bucket", storage: fakeStorage });
    const body = Buffer.from([1, 2, 3]);
    await port.save("uploads/s1/o1.pdf", body, "application/pdf");

    expect(bucket).toHaveBeenCalledWith("test-bucket");
    expect(file).toHaveBeenCalledWith("uploads/s1/o1.pdf");
    expect(save).toHaveBeenCalledWith(body, { contentType: "application/pdf", resumable: false });
  });
});
