import { type ExtractSource, type SourceFormat, UnsupportedFormatError } from "./types.js";

/**
 * F01: 素材の形式を推定する（純粋関数・外部依存なし）。
 *
 * 優先順:
 *   1. `source.format` が明示されていればそれを採用（推定スキップ）
 *   2. `mimeType`（最も信頼できる）
 *   3. `filename` の拡張子
 *
 * いずれでも判定できなければ {@link UnsupportedFormatError} を投げる（推測で誤分類しない）。
 */

const MIME_TO_FORMAT: Readonly<Record<string, SourceFormat>> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "text/plain": "text",
  "text/markdown": "text",
  "text/csv": "text",
};

const EXT_TO_FORMAT: Readonly<Record<string, SourceFormat>> = {
  pdf: "pdf",
  docx: "docx",
  xlsx: "xlsx",
  txt: "text",
  md: "text",
  csv: "text",
  png: "image",
  jpg: "image",
  jpeg: "image",
  webp: "image",
  gif: "image",
  tiff: "image",
  tif: "image",
};

/** MIME の `image/*` は一括で image とみなす（個別 subtype を列挙しすぎない）。 */
function formatFromMime(mimeType: string): SourceFormat | undefined {
  const normalized = mimeType.trim().toLowerCase().split(";", 1)[0]?.trim() ?? "";
  if (normalized in MIME_TO_FORMAT) {
    return MIME_TO_FORMAT[normalized];
  }
  if (normalized.startsWith("image/")) {
    return "image";
  }
  return undefined;
}

function extensionOf(filename: string): string | undefined {
  const dot = filename.lastIndexOf(".");
  if (dot < 0 || dot === filename.length - 1) {
    return undefined;
  }
  return filename.slice(dot + 1).toLowerCase();
}

function formatFromFilename(filename: string): SourceFormat | undefined {
  const ext = extensionOf(filename);
  return ext ? EXT_TO_FORMAT[ext] : undefined;
}

/** 形式を推定する。判定不能なら UnsupportedFormatError。 */
export function detectFormat(source: ExtractSource): SourceFormat {
  if (source.format) {
    return source.format;
  }
  if (source.mimeType) {
    const byMime = formatFromMime(source.mimeType);
    if (byMime) {
      return byMime;
    }
  }
  if (source.filename) {
    const byName = formatFromFilename(source.filename);
    if (byName) {
      return byName;
    }
  }
  throw new UnsupportedFormatError(
    `mimeType=${source.mimeType ?? "?"} filename=${source.filename ?? "?"}`,
  );
}
