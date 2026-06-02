/**
 * F01 (#509 S2b): 教員ファイルアップロードの入力検証（MIME allowlist + サイズ上限）。
 *
 * セキュリティ境界（NFR03 / threat S/T）:
 * - **MIME allowlist**: PDF / DOCX / XLSX / PNG / JPEG のみ受理。実行可能・スクリプト・
 *   レガシー Office(.doc/.xls) 等は拒否（415）。判定は **MIME を一次ソース**にし、保存キーの
 *   拡張子も MIME から導出する（クライアントのファイル名を信頼しない = path traversal 防止）。
 * - **サイズ上限 50MB**: Content-Length での早期棄却 + 実バイト長の二段。メモリ膨張を防ぐ。
 *
 * 純粋関数のみ（副作用なし）。route とテストの両方から使う単一ソース（ルール3）。
 */

/** アップロード上限（F01 受け入れ条件: 50 MB / ファイル）。 */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** 許可するアップロード種別。`mime` は受理判定の一次キー、`ext` は保存キーの拡張子（サーバ導出）。 */
export interface AllowedUploadType {
  /** 受理する MIME タイプ（完全一致）。 */
  readonly mime: string;
  /** 保存オブジェクトキーに付与する拡張子（ファイル名由来でなく MIME 由来 = traversal 不能）。 */
  readonly ext: string;
}

/**
 * 許可 MIME → 拡張子。F01 受け入れ条件の PDF / DOCX / XLSX / PNG / JPEG。
 * 抽出レイヤ（@kimiterrace/ai の extractText）が対応する形式に揃える。
 * 画像（png/jpeg）はアップロード自体は受理するが、テキスト化は OCR 配線（ADR-024 決定3）後。
 */
export const ALLOWED_UPLOAD_TYPES: readonly AllowedUploadType[] = [
  { mime: "application/pdf", ext: "pdf" },
  {
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ext: "docx",
  },
  {
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ext: "xlsx",
  },
  { mime: "image/png", ext: "png" },
  { mime: "image/jpeg", ext: "jpg" },
] as const;

/**
 * MIME から許可種別を解決する。許可外なら null（呼び出し側は 415 を返す）。
 * MIME は前後空白・大小・charset パラメータ（"; charset=..."）の揺れを正規化して照合する。
 */
export function resolveUploadType(mimeType: string | null | undefined): AllowedUploadType | null {
  if (!mimeType) {
    return null;
  }
  // "application/pdf; charset=binary" のようなパラメータ付き MIME を本体だけに正規化。
  const normalized = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return ALLOWED_UPLOAD_TYPES.find((t) => t.mime === normalized) ?? null;
}

/** Content-Length（文字列ヘッダ）が上限超過か。解析不能・未指定は false（実バイト長で再検査する）。 */
export function exceedsContentLength(contentLength: string | null | undefined): boolean {
  if (!contentLength) {
    return false;
  }
  const n = Number(contentLength);
  return Number.isFinite(n) && n > MAX_UPLOAD_BYTES;
}

/**
 * アップロード API (`POST /api/teacher-inputs/upload`) の HTTP ステータスを、教員向けの日本語
 * エラーメッセージに写像する (#509 S3b、クライアント表示用の純粋関数)。route の error コードに依存せず
 * status だけで判定し、想定外は汎用文言にフォールバックする。
 */
export function uploadErrorMessage(status: number): string {
  switch (status) {
    case 401:
      return "ログインが必要です。";
    case 403:
      return "アップロードの権限がありません。";
    case 413:
      return "ファイルが大きすぎます（上限 50MB）。";
    case 415:
      return "対応していない形式です（PDF / Word / Excel / PNG / JPEG のみ）。";
    case 422:
      return "ファイルを読み取れませんでした（破損・暗号化の可能性）。";
    case 502:
      return "保存に失敗しました。時間をおいて再試行してください。";
    default:
      return "アップロードに失敗しました。";
  }
}
