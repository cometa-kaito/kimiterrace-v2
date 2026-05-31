import { Workbook as ExceljsWorkbook } from "exceljs";
import {
  type DocumentExtractor,
  ExtractFailedError,
  type ExtractSource,
  type ExtractedText,
  ExtractorNotConfiguredError,
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
 * - `image` は OCR が外部委託（ルール4 / ADR-024 決定2）になるため、ガードが整うまでスタブのまま。
 *   配線前は {@link ExtractorNotConfiguredError} を投げるフェイルクローズスタブ。
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
      const doc = await pdfjs.getDocument({ data }).promise;
      try {
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
            page.cleanup();
          }
        }
        return {
          text: pageTexts.join("\n"),
          format: "pdf",
          meta: { pageCount },
        };
      } finally {
        await doc.destroy();
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
 * 画像 OCR 抽出スタブ（#12 では触らない / ADR-024 決定2）。
 * TODO(F01-ocr): OCR バックエンドを追加して `meta.ocrUsed = true` を立てる。
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
