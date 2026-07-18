import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P1 写真取込 Server Action（photoImportChatMessageAction）のセキュリティ分岐検証
 * （DB/Vertex/auth はモック、OCR/rate は deps 注入）。三段ガード = rate 前置（egress の前に取得・
 * 拒否時は OCR を呼ばない）・OCR egress 監査（no_text でも fail-safe で残す）・画像のみ受理
 * （imageOnly）・マジックバイト検査（偽装 MIME を egress させない）を固める。
 * assistant-actions.test.ts と同じフェイク構成（assistant-shared.ts の共有実装を経由する）。
 */

// vi.hoisted: vi.mock factory は巻き上げられるため、参照するフェイクは hoisted で先に生成する。
const h = vi.hoisted(() => {
  class FakeAiDisabledError extends Error {}
  class FakeUnsupportedFormatError extends Error {}
  class FakeExtractorNotConfiguredError extends Error {}
  class FakeExtractFailedError extends Error {}
  return {
    AiDisabledError: FakeAiDisabledError,
    UnsupportedFormatError: FakeUnsupportedFormatError,
    ExtractorNotConfiguredError: FakeExtractorNotConfiguredError,
    ExtractFailedError: FakeExtractFailedError,
    assertAiEnabled: vi.fn(),
    extractText: vi.fn(),
    requireRole: vi.fn(),
    insertValues: vi.fn(),
  };
});

vi.mock("@kimiterrace/ai", () => ({
  AiDisabledError: h.AiDisabledError,
  UnsupportedFormatError: h.UnsupportedFormatError,
  ExtractorNotConfiguredError: h.ExtractorNotConfiguredError,
  ExtractFailedError: h.ExtractFailedError,
  assertAiEnabled: h.assertAiEnabled,
  extractText: h.extractText,
  createPerSchoolRateLimiter: () => ({ tryAcquire: () => true }),
  createGeminiOcrClient: () => ({ recognize: vi.fn() }),
}));
vi.mock("@/lib/auth/guard", () => ({ requireRole: h.requireRole }));
vi.mock("@/lib/db", () => ({
  withSession: (cb: (tx: unknown) => unknown) => cb({ insert: () => ({ values: h.insertValues }) }),
}));
vi.mock("@kimiterrace/db", () => ({ auditLog: {} }));

import { CHAT_MESSAGE_MAX } from "../../lib/editor/assistant-chat-core";
import { photoImportChatMessageAction } from "../../lib/editor/photo-import-actions";

const CLASS_ID = "11111111-1111-4111-8111-111111111111";

/** PNG マジックバイト（実 `hasValidImageMagicBytes` を通す最小バイト列）。 */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

/** File コンストラクタの BlobPart 型（ArrayBuffer 固定）に合わせてコピーする（キャスト回避・ルール3）。 */
function toBlobPart(bytes: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(bytes.length);
  new Uint8Array(buf).set(bytes);
  return buf;
}

function pngForm(bytes: Uint8Array = PNG_BYTES, type = "image/png", name = "print.png"): FormData {
  const fd = new FormData();
  fd.set("file", new File([toBlobPart(bytes)], name, { type }));
  return fd;
}

function deps(overrides: Partial<{ acquire: boolean }> = {}) {
  return {
    rateLimiter: { tryAcquire: vi.fn().mockReturnValue(overrides.acquire ?? true) },
    nowMs: 1000,
  };
}

beforeEach(() => {
  h.requireRole.mockReset().mockResolvedValue({ uid: "u1", schoolId: "s1", role: "teacher" });
  h.assertAiEnabled.mockReset().mockImplementation(() => undefined);
  h.extractText
    .mockReset()
    .mockResolvedValue({ text: "7月7日の時間割変更 1限 体育", meta: { ocrUsed: true } });
  h.insertValues.mockReset().mockResolvedValue(undefined);
});

describe("photoImportChatMessageAction", () => {
  it("正常系: OCR テキストからチャット注入ターンを返し、egress を監査する", async () => {
    const d = deps();
    const r = await photoImportChatMessageAction("class", CLASS_ID, pngForm(), d);
    expect(r).toMatchObject({ ok: true });
    if (r.ok) {
      expect(r.message).toContain("【プリント本文】");
      expect(r.message).toContain("7月7日の時間割変更");
      expect(r.message.length).toBeLessThanOrEqual(CHAT_MESSAGE_MAX);
    }
    // rate は egress の前に 1 回だけ（school key）。
    expect(d.rateLimiter.tryAcquire).toHaveBeenCalledExactlyOnceWith("s1", 1000);
    // OCR egress 監査（本文非保存・ハッシュ+文字数のみ）。
    expect(h.insertValues).toHaveBeenCalledTimes(1);
    const audit = h.insertValues.mock.calls[0]?.[0] as {
      diff?: { ocrEgress?: boolean; mediaType?: string };
    };
    expect(audit.diff?.ocrEgress).toBe(true);
    expect(audit.diff?.mediaType).toBe("image/png");
  });

  it("画像以外（PDF 等）は認可より前に unsupported_format で弾く（imageOnly）", async () => {
    const fd = new FormData();
    fd.set(
      "file",
      new File([toBlobPart(new Uint8Array([0x25, 0x50, 0x44, 0x46]))], "a.pdf", {
        type: "application/pdf",
      }),
    );
    const r = await photoImportChatMessageAction("class", CLASS_ID, fd, deps());
    expect(r).toEqual({ ok: false, reason: "unsupported_format" });
    expect(h.requireRole).not.toHaveBeenCalled();
    expect(h.extractText).not.toHaveBeenCalled();
  });

  it("rate 拒否時は OCR（egress）を呼ばない（前置ガード）", async () => {
    const r = await photoImportChatMessageAction(
      "class",
      CLASS_ID,
      pngForm(),
      deps({ acquire: false }),
    );
    expect(r).toEqual({ ok: false, reason: "rate_limited" });
    expect(h.extractText).not.toHaveBeenCalled();
    expect(h.insertValues).not.toHaveBeenCalled();
  });

  it("宣言 MIME とマジックバイト不整合の偽装画像は egress させず unsupported_format", async () => {
    const r = await photoImportChatMessageAction(
      "class",
      CLASS_ID,
      pngForm(new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08])),
      deps(),
    );
    expect(r).toEqual({ ok: false, reason: "unsupported_format" });
    expect(h.extractText).not.toHaveBeenCalled();
  });

  it("AI 無効（kill-switch）は disabled", async () => {
    h.assertAiEnabled.mockImplementation(() => {
      throw new h.AiDisabledError("off");
    });
    const r = await photoImportChatMessageAction("class", CLASS_ID, pngForm(), deps());
    expect(r).toEqual({ ok: false, reason: "disabled" });
    expect(h.extractText).not.toHaveBeenCalled();
  });

  it("エディタロール外（schoolId なし）は forbidden", async () => {
    h.requireRole.mockResolvedValue({ uid: "u1", schoolId: null, role: "teacher" });
    const r = await photoImportChatMessageAction("class", CLASS_ID, pngForm(), deps());
    expect(r).toEqual({ ok: false, reason: "forbidden" });
  });

  it("OCR が空テキストなら no_text（ただし egress 監査は fail-safe で残す）", async () => {
    h.extractText.mockResolvedValue({ text: "   ", meta: { ocrUsed: true } });
    const r = await photoImportChatMessageAction("class", CLASS_ID, pngForm(), deps());
    expect(r).toEqual({ ok: false, reason: "no_text" });
    expect(h.insertValues).toHaveBeenCalledTimes(1);
  });

  it("ファイル未添付は empty", async () => {
    const r = await photoImportChatMessageAction("class", CLASS_ID, new FormData(), deps());
    expect(r).toEqual({ ok: false, reason: "empty" });
  });
});
