import type { wrapLanguageModel } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Gemini マルチモーダル OCR アダプタ（`createGeminiOcrClient`, ADR-038）のランタイム契約テスト。
 *
 * vertex.test.ts と同じく `@ai-sdk/google-vertex` を `vi.mock` し、LanguageModelV2 spec の最小フェイクを
 * 差し込んで GCP 無しで配線を固定する（実 Vertex 呼び出しは CI に持ち込まない、ADR-012）。固定する契約:
 *  1. 画像を **マルチモーダルの file パート**として送る（v2 prompt に画像バイト + mediaType が乗る）。
 *  2. mediaType ヒントを渡せば採用し、未指定なら既定 image/png に倒す。
 *  3. モデルのテキスト出力をそのまま `OcrResult.text` に返す（confidence は付けない）。
 */

type FakeModel = Parameters<typeof wrapLanguageModel>[0]["model"];
type DoGenerateOptions = Parameters<FakeModel["doGenerate"]>[0];

const capturedOptions: DoGenerateOptions[] = [];
let nextText = "";

function buildFakeModel(modelId: string): FakeModel {
  return {
    specificationVersion: "v2",
    provider: "google.vertex.fake",
    modelId,
    supportedUrls: {},
    async doGenerate(options: DoGenerateOptions) {
      capturedOptions.push(options);
      return {
        content: [{ type: "text" as const, text: nextText }],
        finishReason: "stop" as const,
        usage: { inputTokens: 5, outputTokens: 9, totalTokens: 14 },
        warnings: [],
      };
    },
    doStream() {
      throw new Error("doStream は本テストでは未使用");
    },
  };
}

vi.mock("@ai-sdk/google-vertex", () => ({
  createVertex: vi.fn(() => (modelId: string) => buildFakeModel(modelId)),
}));

const { createGeminiOcrClient } = await import("../ocr/gemini.js");

const CONFIG = { project: "dummy", location: "asia-northeast1" };
const IMG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG マジック
// 既知シグネチャを持たないバイト列。AI SDK はバイト列から mediaType を**自動検出**し、検出できた場合は
// それを採用する（マジックバイト検証済の png/jpeg では検出が効く）。検出不能なこのバイト列を使うと、
// アダプタが渡す mediaType ヒント/既定がそのまま v2 prompt に乗ることを確認できる。
const UNKNOWN = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);

/** v2 prompt の user メッセージから file（画像）パートを取り出す。 */
function imagePartsOf(options: DoGenerateOptions): Array<{ mediaType?: string }> {
  const parts: Array<{ mediaType?: string }> = [];
  for (const msg of options.prompt) {
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (part.type === "file") {
        parts.push({ mediaType: part.mediaType });
      }
    }
  }
  return parts;
}

beforeEach(() => {
  capturedOptions.length = 0;
  nextText = "";
});

describe("createGeminiOcrClient（Gemini OCR アダプタ契約・ADR-038）", () => {
  it("モデルのテキスト出力を OcrResult.text に返す（confidence は付けない）", async () => {
    nextText = "1限 国語\n2限 数学";
    const res = await createGeminiOcrClient(CONFIG).recognize(IMG, "image/png");
    expect(res.text).toBe("1限 国語\n2限 数学");
    expect(res.confidence).toBeUndefined();
  });

  it("実画像（PNG マジック）は SDK が内容から mediaType を検出して file パートで送る", async () => {
    nextText = "x";
    await createGeminiOcrClient(CONFIG).recognize(IMG, "image/jpeg");
    expect(capturedOptions).toHaveLength(1);
    const images = imagePartsOf(capturedOptions[0] as DoGenerateOptions);
    expect(images).toHaveLength(1);
    // PNG シグネチャを持つので SDK の内容検出が hint より優先される（実 png/jpeg では検出が効く）。
    expect(images[0]?.mediaType).toBe("image/png");
  });

  it("検出不能なバイト列では渡した mediaType ヒントが file パートに乗る", async () => {
    nextText = "x";
    await createGeminiOcrClient(CONFIG).recognize(UNKNOWN, "image/jpeg");
    const images = imagePartsOf(capturedOptions[0] as DoGenerateOptions);
    expect(images).toHaveLength(1);
    expect(images[0]?.mediaType).toBe("image/jpeg");
  });

  it("mediaType 未指定なら既定 image/png に倒す", async () => {
    nextText = "x";
    await createGeminiOcrClient(CONFIG).recognize(UNKNOWN);
    const images = imagePartsOf(capturedOptions[0] as DoGenerateOptions);
    expect(images[0]?.mediaType).toBe("image/png");
  });

  it("application/pdf は file パートとして mediaType=application/pdf で送る（ネイティブ PDF OCR・ADR-038）", async () => {
    nextText = "連絡\t明日は遠足";
    const res = await createGeminiOcrClient(CONFIG).recognize(UNKNOWN, "application/pdf");
    expect(res.text).toBe("連絡\t明日は遠足");
    const files = imagePartsOf(capturedOptions[0] as DoGenerateOptions);
    expect(files).toHaveLength(1);
    expect(files[0]?.mediaType).toBe("application/pdf");
  });
});
