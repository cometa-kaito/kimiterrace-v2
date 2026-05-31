import {
  type DocumentExtractor,
  type ExtractSource,
  type ExtractedText,
  ExtractorNotConfiguredError,
  type SourceFormat,
} from "./types.js";

/**
 * F01 具象抽出器。
 *
 * - `text` は依存パーサ不要なので **実装済み**（UTF-8 デコード）。パイプラインの素通り経路に使う。
 * - `pdf` / `docx` / `xlsx` / `image` は依存パーサを **このレイヤで import しない** 方針のため、
 *   配線前は {@link ExtractorNotConfiguredError} を投げるフェイルクローズスタブ。
 *   依存追加（pnpm-lock 更新）とパーサ呼び出しの実装は別 PR で行う（TODO 参照）。
 *
 * 抽出済みテキストは PII 未マスクである点に注意（types.ts の注記参照、ルール4）。
 */

abstract class BaseExtractor implements DocumentExtractor {
  abstract readonly format: SourceFormat;
  supports(format: SourceFormat): boolean {
    return format === this.format;
  }
  abstract extract(source: ExtractSource): Promise<ExtractedText>;
}

/** UTF-8 テキスト（.txt / .md / .csv）をそのままデコードする。依存不要。 */
export class TextExtractor extends BaseExtractor {
  readonly format = "text" as const;
  async extract(source: ExtractSource): Promise<ExtractedText> {
    // fatal:false で不正バイトは U+FFFD に置換（途中の壊れ文字で全体を失わない）。
    const text = new TextDecoder("utf-8", { fatal: false }).decode(source.bytes);
    return { text, format: "text" };
  }
}

/**
 * PDF 抽出スタブ。
 * TODO(F01-deps): `pdfjs-dist`（または `pdf-parse`）を packages/ai に追加し、
 * ページごとのテキストレイヤを抽出して結合、`meta.pageCount` を埋める。
 * スキャン PDF（テキストレイヤなし）は OCR フォールバックが要るため ImageExtractor と方針を合わせる。
 */
export class PdfExtractor extends BaseExtractor {
  readonly format = "pdf" as const;
  async extract(_source: ExtractSource): Promise<ExtractedText> {
    throw new ExtractorNotConfiguredError("pdf", "pdfjs-dist");
  }
}

/**
 * Word(.docx) 抽出スタブ。
 * TODO(F01-deps): `mammoth`（docx → テキスト/HTML）を追加し、段落テキストを抽出する。
 */
export class DocxExtractor extends BaseExtractor {
  readonly format = "docx" as const;
  async extract(_source: ExtractSource): Promise<ExtractedText> {
    throw new ExtractorNotConfiguredError("docx", "mammoth");
  }
}

/**
 * Excel(.xlsx) 抽出スタブ。
 * TODO(F01-deps): `exceljs`（または `xlsx`）を追加し、シートごとに行をテキスト化、
 * `meta.sheetNames` を埋める。セル結合・数式評価の扱いは配線時に決める。
 */
export class XlsxExtractor extends BaseExtractor {
  readonly format = "xlsx" as const;
  async extract(_source: ExtractSource): Promise<ExtractedText> {
    throw new ExtractorNotConfiguredError("xlsx", "exceljs");
  }
}

/**
 * 画像 OCR 抽出スタブ。
 * TODO(F01-deps): OCR バックエンドを追加して `meta.ocrUsed = true` を立てる。
 * ⚠ ルール4: 外部 OCR（Vertex Vision / Cloud Vision）は **画像そのものを外部委託に送る**。
 * 生徒の顔・氏名が写る画像をそのまま送らない設計（オンデバイス OCR か、送信前同意・監査必須）を
 * 配線時に ADR 化すること。抽出後テキストは下流で必ず PII マスキングを通す。
 */
export class ImageExtractor extends BaseExtractor {
  readonly format = "image" as const;
  async extract(_source: ExtractSource): Promise<ExtractedText> {
    throw new ExtractorNotConfiguredError("image", "@google-cloud/vision");
  }
}
