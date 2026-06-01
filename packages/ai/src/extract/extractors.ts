import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Workbook as ExceljsWorkbook } from "exceljs";
import {
  type DocumentExtractor,
  ExtractFailedError,
  type ExtractSource,
  type ExtractedText,
  ExtractorNotConfiguredError,
  type OcrClient,
  type SourceFormat,
} from "./types.js";

/**
 * F01 具象抽出器。
 *
 * - `text` は依存パーサ不要なので **実装済み**（UTF-8 デコード）。パイプラインの素通り経路に使う。
 * - `pdf` / `docx` / `xlsx` は #12 / ADR-024 でローカルパーサに配線済み:
 *   - pdf  → `pdfjs-dist`（Node legacy build）
 *   - docx → `mammoth`
 *   - xlsx → `exceljs`
 * - `image` は OCR が外部委託（ルール4 / ADR-024 決定2）。OcrClient を注入して使う（決定3 の依存逆転）。
 *   未注入なら {@link ExtractorNotConfiguredError} を投げるフェイルクローズ。
 *
 * 抽出済みテキストは **PII 未マスク** のまま返す契約（types.ts の注記参照、ルール4）。
 * マスキングは下流の structureContent / embedding 経路の責務。ここでは絶対にマスクしない。
 *
 * パーサが投げた例外は握りつぶさず {@link ExtractFailedError} にラップして再 throw する
 * （ADR-024 決定4: フェイルクローズ。黙って空文字を返さない）。
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

/** Uint8Array → Node Buffer。パーサが Buffer / ArrayBuffer を要求する場合に使う。 */
function toBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes);
}

/**
 * pdfjs-dist v6 の標準フォント (Helvetica 等の標準14フォント) データ所在を解決する。
 *
 * v5 では未設定でも警告のみで text 抽出は成功したが、**v6 では `standardFontDataUrl` 未設定だと
 * 標準フォント PDF の `getTextContent()` が `UnknownErrorException` で壊れる**（実 smoke で確認）。
 * 配布物に同梱される `pdfjs-dist/standard_fonts/` ディレクトリの `file://` URL（末尾スラッシュ必須）を
 * `createRequire(import.meta.url).resolve` で解決して返す。
 *
 * **本番バンドル (Cloud Run / Turbopack) で `pdfjs-dist/package.json` が解決できない環境**では
 * `undefined` を返し、呼び出し側は standardFontDataUrl 無しで抽出を試みる（v5 同等の defensive 動作。
 * 標準フォント以外の埋め込みフォント PDF は引き続き抽出可能）。フォント解決不能を理由に抽出全体を
 * 落とさない（フェイルクローズではなく best-effort 側に倒す。テキスト皆無なら下流が検知する）。
 */
function resolveStandardFontDataUrl(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    // package.json は exports に依存せず常に解決できる（v6 は exports フィールド無し）。
    const pkgJsonPath = require.resolve("pdfjs-dist/package.json");
    const pkgRoot = pkgJsonPath.slice(0, pkgJsonPath.length - "package.json".length);
    // pathToFileURL はディレクトリに末尾スラッシュを付与する。pdfjs は末尾スラッシュを要求。
    return pathToFileURL(`${pkgRoot}standard_fonts/`).href;
  } catch {
    return undefined;
  }
}

/**
 * PDF 抽出器（`pdfjs-dist` Node legacy build）。
 *
 * 各ページの text layer を `getTextContent()` で取り出し、items を結合する。
 * テキストレイヤを持たないスキャン PDF はここでは空に近い結果になり得るが、OCR フォールバックは
 * ImageExtractor 側（別 PR / ADR-024 決定2）の責務なのでここでは行わない。
 * 抽出テキストは PII 未マスクのまま返す（マスクは下流）。
 */
export class PdfExtractor extends BaseExtractor {
  readonly format = "pdf" as const;
  async extract(source: ExtractSource): Promise<ExtractedText> {
    // Node では DOM 非依存の legacy build を使う（CLAUDE.md / タスク指定）。
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    try {
      // pdfjs は渡した TypedArray を内部で transfer/detach するため、コピーを渡して呼び出し側の bytes を守る。
      const data = new Uint8Array(source.bytes);
      // v6 では標準フォント PDF の getTextContent に standardFontDataUrl が必須（未設定だと抽出が壊れる）。
      // 解決できない環境では undefined のまま渡し、v5 同等の best-effort 動作に倒す。
      const standardFontDataUrl = resolveStandardFontDataUrl();
      // v6: getDocument は PDFDocumentLoadingTask を返す。クリーンアップ (worker 破棄) は v5 の
      // doc.destroy() ではなく loadingTask.destroy() に移った（PDFDocumentProxy.destroy は削除済み）。
      const loadingTask = pdfjs.getDocument(
        standardFontDataUrl ? { data, standardFontDataUrl } : { data },
      );
      try {
        const doc = await loadingTask.promise;
        const pageCount = doc.numPages;
        const pageTexts: string[] = [];
        for (let pageNo = 1; pageNo <= pageCount; pageNo++) {
          const page = await doc.getPage(pageNo);
          try {
            const content = await page.getTextContent();
            const line = content.items
              // TextItem だけが `str` を持つ（TextMarkedContent は構造マーカーで除外）。
              .map((item) => ("str" in item ? item.str : ""))
              .join("");
            pageTexts.push(line);
          } finally {
            // PDFPageProxy.cleanup() は v6 でも有効（ループ毎にページのレンダ資源を解放）。
            page.cleanup();
          }
        }
        return {
          text: pageTexts.join("\n"),
          format: "pdf",
          meta: { pageCount },
        };
      } finally {
        await loadingTask.destroy();
      }
    } catch (cause) {
      throw new ExtractFailedError("pdf", "pdfjs-dist", cause);
    }
  }
}

/**
 * Word(.docx) 抽出器（`mammoth`）。
 *
 * `extractRawText` で段落テキストを取り出す（書式は捨て、素テキストのみ）。
 * 抽出テキストは PII 未マスクのまま返す（マスクは下流）。
 */
export class DocxExtractor extends BaseExtractor {
  readonly format = "docx" as const;
  async extract(source: ExtractSource): Promise<ExtractedText> {
    // mammoth は CJS (`export =`)。verbatimModuleSyntax 下では dynamic import の default を取る。
    const mammoth = (await import("mammoth")).default;
    try {
      const result = await mammoth.extractRawText({ buffer: toBuffer(source.bytes) });
      return { text: result.value, format: "docx" };
    } catch (cause) {
      throw new ExtractFailedError("docx", "mammoth", cause);
    }
  }
}

/**
 * Excel(.xlsx) 抽出器（`exceljs`）。
 *
 * 各 worksheet の行を走査し、セル値をタブ区切りでテキスト化して結合する。
 * `meta.sheetNames` にシート名一覧を埋める。数式は評価済み結果（`cell.text`）を採用。
 * 抽出テキストは PII 未マスクのまま返す（マスクは下流）。
 */
export class XlsxExtractor extends BaseExtractor {
  readonly format = "xlsx" as const;
  async extract(source: ExtractSource): Promise<ExtractedText> {
    const wb = new ExceljsWorkbook();
    try {
      // exceljs の load は ArrayBuffer 互換を要求する型（`interface Buffer extends ArrayBuffer`）。
      // bytes の見ている範囲だけを正確に切り出した ArrayBuffer を渡す（offset/length を尊重）。
      const ab = source.bytes.buffer.slice(
        source.bytes.byteOffset,
        source.bytes.byteOffset + source.bytes.byteLength,
      ) as ArrayBuffer;
      await wb.xlsx.load(ab);
      const sheetNames: string[] = [];
      const sheetTexts: string[] = [];
      for (const sheet of wb.worksheets) {
        sheetNames.push(sheet.name);
        const rows: string[] = [];
        sheet.eachRow({ includeEmpty: false }, (row) => {
          const cells: string[] = [];
          row.eachCell({ includeEmpty: false }, (cell) => {
            // cell.text は表示文字列（数式は評価結果、日付は整形済み）。
            cells.push(cell.text);
          });
          rows.push(cells.join("\t"));
        });
        // シート見出し + 本文。空シートでも見出しは残し、後段が件数を把握できるようにする。
        sheetTexts.push([`# ${sheet.name}`, ...rows].join("\n"));
      }
      return {
        text: sheetTexts.join("\n\n"),
        format: "xlsx",
        meta: { sheetNames },
      };
    } catch (cause) {
      throw new ExtractFailedError("xlsx", "exceljs", cause);
    }
  }
}

/**
 * 画像 OCR 抽出器（ADR-024 決定2/3）。
 *
 * OCR バックエンドは {@link OcrClient} として注入する（依存逆転）。実体は Cloud Vision アダプタ
 * （{@link "./ocr/vision".createVisionOcrClient}）を想定するが、本クラスは Vision SDK を直接
 * import せず、テストはフェイク OcrClient で全分岐を検証できる。
 *
 * ⚠ ADR-024 決定2（フェイルセーフ三段ガード）— 本クラスは技術的な抽出のみを担い、以下は呼び出し側の責務:
 *   1. **オプトイン**: 教員が「画像から読み取る」を選んだ場合のみ画像 OCR を起動する。
 *   2. **監査**: OCR 呼び出しを `audit_log` に記録（who / school_id / 画像ハッシュ / 結果文字数）。
 *      画像ハッシュは生 PII 画像由来で 10 年保管対象になりうる点を運用で確認（ADR-024 M2）。
 *   3. **下流マスキング**: 返す `text` は **PII 未マスク**。structureContent / embedding に渡す前に必ずマスクする。
 *
 * OCR を通したことは `meta.ocrUsed = true` で明示し、監査側が外部委託の発生を判別できるようにする。
 * OcrClient 未注入なら {@link ExtractorNotConfiguredError}（フェイルクローズ。黙って空を返さない）。
 */
export class ImageExtractor extends BaseExtractor {
  readonly format = "image" as const;
  constructor(private readonly ocr?: OcrClient) {
    super();
  }
  async extract(source: ExtractSource): Promise<ExtractedText> {
    if (!this.ocr) {
      throw new ExtractorNotConfiguredError("image", "@google-cloud/vision");
    }
    let result: Awaited<ReturnType<OcrClient["recognize"]>>;
    try {
      result = await this.ocr.recognize(source.bytes);
    } catch (cause) {
      throw new ExtractFailedError("image", "@google-cloud/vision", cause);
    }
    return {
      text: result.text,
      format: "image",
      meta: { ocrUsed: true, confidence: result.confidence },
    };
  }
}
