import type { adMediaType } from "@kimiterrace/db/schema";
import { normalizeMimeType } from "../teacher-input/upload-validation";

/**
 * #46 / ADR-037: 広告メディア **アップロードの入力検証**（MIME allowlist + ext + media_type 導出）。
 *
 * セキュリティ境界（NFR03）は教員アップロード（`teacher-input/upload-validation`）と同思想:
 * - **MIME allowlist**: 受理判定は MIME を一次ソースにし、保存キーの拡張子も MIME から導出する
 *   （クライアントのファイル名を信頼しない = path traversal 防止）。
 * - サイズ上限・ストリーム読取・マジックバイト検証・content-length 早期棄却は教員アップロードの汎用
 *   プリミティブ（`MAX_UPLOAD_BYTES` / `readStreamCapped` / `hasValidImageMagicBytes` / `exceedsContentLength`）を
 *   **再利用**する（単一ソース・ルール3）。本ファイルは「広告として何を受理するか」だけを定義する。
 *
 * ## 本スライスは画像のみ（video は follow-up）
 * `ads.media_type` は image / video を持つが、本アップロード受口は **image（PNG/JPEG）に限定**する。動画は
 * (1) Cloud Run のリクエストサイズ上限（HTTP/1 ~32MB）に当たりやすく、(2) ftyp 検証が別途要るため、別 PR で
 * 足す。動画広告は当面フォームの URL 入力で登録できる（配信 Route は種別非依存で stream する）。
 */

/** 広告メディア種別（image / video）。enum 単一ソースから派生（ルール3）。 */
export type AdMediaTypeValue = (typeof adMediaType.enumValues)[number];

/** 受理する広告アップロード種別。`mime` は受理判定の一次キー、`ext` は保存キー拡張子、`mediaType` は ads 行の値。 */
export interface AllowedAdMediaUploadType {
  readonly mime: string;
  readonly ext: string;
  readonly mediaType: AdMediaTypeValue;
}

/** 許可 MIME → ext / media_type。本スライスは画像のみ（PNG / JPEG）。 */
export const ALLOWED_AD_MEDIA_UPLOAD_TYPES: readonly AllowedAdMediaUploadType[] = [
  { mime: "image/png", ext: "png", mediaType: "image" },
  { mime: "image/jpeg", ext: "jpg", mediaType: "image" },
] as const;

/** `<input accept>` 用の MIME 連結。 */
export const AD_MEDIA_ACCEPT = ALLOWED_AD_MEDIA_UPLOAD_TYPES.map((t) => t.mime).join(",");

/** MIME から許可種別を解決する。許可外なら null（呼び出し側は 415）。charset 等の揺れは正規化して照合。 */
export function resolveAdMediaUploadType(
  mimeType: string | null | undefined,
): AllowedAdMediaUploadType | null {
  const normalized = normalizeMimeType(mimeType);
  if (!normalized) {
    return null;
  }
  return ALLOWED_AD_MEDIA_UPLOAD_TYPES.find((t) => t.mime === normalized) ?? null;
}

/**
 * アップロード API（`POST /api/ads/media`）の HTTP ステータスを管理者向け日本語メッセージに写像する
 * （クライアント表示用の純粋関数）。status だけで判定し、想定外は汎用文言にフォールバックする。
 */
export function adUploadErrorMessage(status: number): string {
  switch (status) {
    case 401:
      return "ログインが必要です。";
    case 403:
      return "広告メディアをアップロードする権限がありません。";
    case 413:
      return "ファイルが大きすぎます（上限 50MB）。";
    case 415:
      return "対応していない形式です（PNG / JPEG の画像のみ）。";
    case 502:
      return "保存に失敗しました。時間をおいて再試行してください。";
    default:
      return "アップロードに失敗しました。";
  }
}
