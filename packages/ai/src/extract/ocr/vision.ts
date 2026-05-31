import type { OcrClient, OcrResult } from "../types.js";

/**
 * Cloud Vision を実体とする {@link OcrClient} アダプタ（ADR-024 決定2/3）。
 *
 * これは credential を要する**外部委託の境界**であり、`model/vertex.ts`（実 Vertex アダプタ）と
 * 同様に単体テストの対象外とする（テストは ImageExtractor をフェイク OcrClient で検証する）。
 * SDK は実際に OCR するときだけ動的 import し、barrel を軽く保つ／native 依存を遅延させる。
 *
 * 認証は Workload Identity / ADC を使用する（JSON キーファイル禁止・CLAUDE.md ルール5）。
 *
 * ⚠ ADR-024 M1（データレジデンシー）: Cloud Vision は Vertex と異なりリージョン保証の前提が違う。
 * NFR07 の越境禁止を満たす設定（リージョナルエンドポイント等）を **配線時に実証**すること。
 * 保証できない場合は ADR-024 代替A（オンデバイス OCR）の再評価トリガとする。
 */
export interface VisionOcrConfig {
  /**
   * リージョナル API エンドポイント（例 `"eu-vision.googleapis.com"`）。
   * データレジデンシー要件に合わせて指定する（ADR-024 M1。未指定はグローバル endpoint）。
   */
  apiEndpoint?: string;
}

export function createVisionOcrClient(config: VisionOcrConfig = {}): OcrClient {
  return {
    async recognize(bytes: Uint8Array): Promise<OcrResult> {
      const { ImageAnnotatorClient } = await import("@google-cloud/vision");
      const client = new ImageAnnotatorClient(
        config.apiEndpoint ? { apiEndpoint: config.apiEndpoint } : {},
      );
      // documentTextDetection は密なテキスト（文書・配布物）向け。content にバイト列を直接渡す。
      const [result] = await client.documentTextDetection({
        image: { content: Buffer.from(bytes) },
      });
      return {
        text: result.fullTextAnnotation?.text ?? "",
        // pages[0].confidence は number | null | undefined。null は undefined に正規化。
        confidence: result.fullTextAnnotation?.pages?.[0]?.confidence ?? undefined,
      };
    },
  };
}
