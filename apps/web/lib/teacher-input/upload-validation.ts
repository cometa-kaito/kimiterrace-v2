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
 * 許可 MIME → 拡張子。F01 受け入れ条件の PDF / DOCX / XLSX / CSV / PNG / JPEG。
 * 抽出レイヤ（@kimiterrace/ai の extractText）が対応する形式に揃える。
 * CSV（text/csv）は TextExtractor が UTF-8 デコードで素通り（表の取り込み・ユーザー決定 2026-06-13）。
 * 画像（png/jpeg）は Gemini マルチモーダル OCR（ADR-038）で配線済（旧 ADR-024 決定3 の Vision を supersede）。
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
  { mime: "text/csv", ext: "csv" },
  { mime: "image/png", ext: "png" },
  { mime: "image/jpeg", ext: "jpg" },
] as const;

/**
 * MIME から許可種別を解決する。許可外なら null（呼び出し側は 415 を返す）。
 * MIME は前後空白・大小・charset パラメータ（"; charset=..."）の揺れを正規化して照合する。
 */
/** MIME 文字列を本体だけに正規化する（charset 等パラメータ除去・小文字化・trim）。空/未指定は ""。 */
export function normalizeMimeType(mimeType: string | null | undefined): string {
  if (!mimeType) {
    return "";
  }
  // "application/pdf; charset=binary" のようなパラメータ付き MIME を本体だけに正規化。
  return mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

export function resolveUploadType(mimeType: string | null | undefined): AllowedUploadType | null {
  const normalized = normalizeMimeType(mimeType);
  if (!normalized) {
    return null;
  }
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
 * multipart エンベロープ（boundary・各フィールドヘッダ）のオーバーヘッド余白（PR #522 M-1）。
 * ストリーム読取のハード上限はファイル本体の 50MB にこの余白を足した値にし、実ファイルの厳密な
 * 50MB 判定は呼び出し側が `file.size` / 実バイト長で別途行う（ここは粗いメモリ保護バックストップ）。
 */
export const MULTIPART_OVERHEAD_MARGIN = 1024 * 1024; // 1 MB

/** body ストリーム読取のハード上限（バイト）。{@link MAX_UPLOAD_BYTES} + multipart 余白。 */
export const MAX_REQUEST_BYTES = MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD_MARGIN;

/**
 * body ストリームがハード上限を超えた（PR #522 M-1）。`request.formData()` / `arrayBuffer()` は
 * Content-Length 詐称・chunked 転送時に本体全体をメモリへバッファしてからサイズ判定に到達するため、
 * 累積バイト数を数えて上限超過で打ち切る前段ガードで投げる。
 */
export class RequestTooLargeError extends Error {
  constructor() {
    super("request body exceeds byte cap");
    this.name = "RequestTooLargeError";
  }
}

/**
 * ReadableStream をバイト上限付きで読み、上限内なら連結済み Uint8Array を返す（PR #522 M-1）。
 * 累積バイト数が `maxBytes` を超えた時点でストリームを cancel し {@link RequestTooLargeError} を投げる
 * ことで、メモリ使用量を上限に縛る（本体全体を無制限にバッファしない）。`body` が無ければ空配列。
 */
export async function readStreamCapped(
  body: ReadableStream<Uint8Array> | null | undefined,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!body) {
    return new Uint8Array(0);
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value || value.byteLength === 0) {
        continue;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        throw new RequestTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    // 超過打ち切り時も正常終了時も、未読分を捨ててロックを解放する。
    try {
      await reader.cancel();
    } catch {
      /* already closed/errored */
    }
    try {
      reader.releaseLock();
    } catch {
      /* lock already released */
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * 画像 MIME の先頭マジックバイト署名（PR #522 L-2）。MIME 文字列は偽装可能なので、画像は宣言 MIME と
 * 実バイト列の整合をここで検査する。PDF/DOCX/XLSX は抽出器パースが fail-close (422) で実質検証されるが、
 * 画像 OCR (Gemini/ADR-038) は画素を読むだけで形式検証をしないため、保存前にマジックバイトで弾く。
 */
const IMAGE_MAGIC_BYTES: Readonly<Record<string, readonly (readonly number[])[]>> = {
  "image/png": [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  // JPEG は SOI(FFD8) + マーカ先頭(FF)。JFIF/EXIF/raw を問わず先頭 3 バイトは共通。
  "image/jpeg": [[0xff, 0xd8, 0xff]],
};

/**
 * 宣言 MIME が画像なら、`bytes` 先頭が対応するマジックバイト署名のいずれかに一致するか検査する。
 * 非画像 MIME（PDF/Office 等）は検査対象外で常に true を返す（抽出器パースが内容を検証するため）。
 */
export function hasValidImageMagicBytes(
  bytes: Uint8Array,
  mimeType: string | null | undefined,
): boolean {
  const signatures = IMAGE_MAGIC_BYTES[normalizeMimeType(mimeType)];
  if (!signatures) {
    return true;
  }
  return signatures.some(
    (sig) => bytes.length >= sig.length && sig.every((b, i) => bytes[i] === b),
  );
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
      return "対応していない形式です（PDF / Word / Excel / CSV / PNG / JPEG のみ）。";
    case 422:
      return "ファイルを読み取れませんでした（破損・暗号化の可能性）。";
    case 502:
      return "保存に失敗しました。時間をおいて再試行してください。";
    default:
      return "アップロードに失敗しました。";
  }
}
