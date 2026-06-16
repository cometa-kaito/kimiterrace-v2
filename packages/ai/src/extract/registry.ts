import { detectFormat } from "./detect.js";
import {
  DocxExtractor,
  ImageExtractor,
  PdfExtractor,
  TextExtractor,
  XlsxExtractor,
} from "./extractors.js";
import {
  type DocumentExtractor,
  type ExtractSource,
  type ExtractedText,
  type OcrClient,
  type SourceFormat,
  UnsupportedFormatError,
} from "./types.js";

/** 既定レジストリの構成オプション。 */
export interface RegistryOptions {
  /** 画像 OCR バックエンド（ADR-024 決定3）。未指定なら image は ExtractorNotConfiguredError。 */
  ocr?: OcrClient;
}

/**
 * F01 抽出オーケストレータ。
 *
 * 形式を推定 →（必要なら）対応する {@link DocumentExtractor} を選んでテキスト化する。
 * 抽出器は依存逆転されており、テストはフェイク抽出器を登録して全分岐を検証できる
 * （structureContent が ModelClient を差し替えられるのと同じ思想）。
 */
export class ExtractorRegistry {
  private readonly byFormat = new Map<SourceFormat, DocumentExtractor>();

  /** 抽出器を登録する（同一形式は後勝ちで上書き）。 */
  register(extractor: DocumentExtractor): this {
    this.byFormat.set(extractor.format, extractor);
    return this;
  }

  /** 指定形式の抽出器を返す。未登録なら undefined。 */
  get(format: SourceFormat): DocumentExtractor | undefined {
    return this.byFormat.get(format);
  }

  /**
   * 素材を形式推定し、対応する抽出器でテキスト化する。
   * 形式未対応（推定不能 or 抽出器未登録）は {@link UnsupportedFormatError}。
   * 抽出器が未配線（依存パーサなし）の場合は抽出器が ExtractorNotConfiguredError を投げる。
   */
  async extract(source: ExtractSource): Promise<ExtractedText> {
    const format = detectFormat(source);
    const extractor = this.byFormat.get(format);
    if (!extractor) {
      throw new UnsupportedFormatError(`no extractor registered for '${format}'`);
    }
    return extractor.extract(source);
  }
}

/**
 * 既定レジストリ: 全形式の抽出器を登録する。
 * `text` / `docx` / `xlsx` は即時動作。`pdf` はテキストレイヤを即時抽出し、`opts.ocr` を渡したときは
 * スキャン PDF（テキストレイヤ希薄）で OCR フォールバックする（未指定ならテキストレイヤのみ）。
 * `image` は `opts.ocr` を渡したときのみ動作し、未指定なら ExtractorNotConfiguredError（フェイルクローズ）。
 */
export function createDefaultRegistry(opts: RegistryOptions = {}): ExtractorRegistry {
  return new ExtractorRegistry()
    .register(new TextExtractor())
    .register(new PdfExtractor(opts.ocr))
    .register(new DocxExtractor())
    .register(new XlsxExtractor())
    .register(new ImageExtractor(opts.ocr));
}

/**
 * 便宜関数: 既定レジストリで素材をテキスト化する（F01 → F03 接続点）。
 * 画像 OCR を使う場合は `opts.ocr` を渡す（ADR-024 決定3）。
 * 戻り値の `text` を structureContent の `input` に渡せる。**渡す前に PII マスキング必須**（ルール4）。
 */
export async function extractText(
  source: ExtractSource,
  opts: RegistryOptions = {},
): Promise<ExtractedText> {
  return createDefaultRegistry(opts).extract(source);
}
