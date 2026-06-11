import { randomUUID } from "node:crypto";
import { getAdMediaUploadStorage } from "@/lib/ads/media-upload-storage";
import { adMediaServingPath, buildAdMediaObjectKey } from "@/lib/ads/media-object";
import { resolveAdMediaUploadType } from "@/lib/ads/media-upload-validation";
import { getCurrentUser } from "@/lib/auth/session";
import { ADS_ROLES } from "@/lib/school-admin/ads-core";
import {
  MAX_REQUEST_BYTES,
  MAX_UPLOAD_BYTES,
  RequestTooLargeError,
  exceedsContentLength,
  hasValidImageMagicBytes,
  readStreamCapped,
} from "@/lib/teacher-input/upload-validation";
import { NextResponse } from "next/server";

/**
 * #46 / ADR-037: 広告メディア **アップロード受口** `POST /api/ads/media`。
 *
 * multipart の `file`（PNG/JPEG）を受け、**公開 ad-media バケット**へ保存し、サイネージが GET する
 * **同一オリジン配信 URL（`/ad-media/<key>`）** を返す。`ads` 行は作らない — 返した URL を `mediaUrl` として
 * 学校側の `createAdAction`（監査付き）で登録する分離設計（本受口はメディアの永続化のみ）。
 *
 * ## セキュリティ（NFR03 / ルール、teacher-input/upload と同思想）
 * - **二層認可**: getCurrentUser で `ADS_ROLES`（school_admin / system_admin）+ 所属校を先に確認（保存前に
 *   ゲート）。テナント未選択の system_admin（schoolId 無し）は 403。teacher / student は 403。
 * - **MIME allowlist + サイズ上限 + マジックバイト**: 宣言 MIME と実バイトの整合を検証してから保存（偽装画像を弾く）。
 * - **保存キーはサーバ生成 UUID + MIME 由来 ext + per-school prefix**（`ads/<schoolId>/<uuid>.<ext>`）。client の
 *   ファイル名・schoolId を path に使わない（path traversal / cross-tenant prefix 跨ぎを構造防止）。
 * - **ルール5**: GCS 認証は ADC（Workload Identity）、バケット名は env、JSON キー無し。secret/PII をログに出さない。
 *
 * 広告は公開掲示物（PII 無し）ゆえ保存先は公開バケット（教員アップロードの per-school 非公開とは正反対のポリシー）。
 */

export const runtime = "nodejs";

function err(status: number, error: string): NextResponse {
  return NextResponse.json({ error }, { status });
}

/** multipart body を {@link MAX_REQUEST_BYTES} 上限付きで読み、同内容で formData を解析する（teacher-input と同方式）。 */
async function parseUploadForm(request: Request): Promise<FormData> {
  const body = request.body;
  if (!body) {
    return await request.formData();
  }
  const buffered = await readStreamCapped(body, MAX_REQUEST_BYTES);
  const contentType = request.headers.get("content-type") ?? "";
  return await new Response(buffered, { headers: { "content-type": contentType } }).formData();
}

/** formData.get の戻りから File 的オブジェクトだけ受ける duck-type ガード。 */
function isUploadFile(
  v: unknown,
): v is { arrayBuffer(): Promise<ArrayBuffer>; size: number; type: string; name: string } {
  return (
    typeof v === "object" &&
    v !== null &&
    "arrayBuffer" in v &&
    typeof (v as { arrayBuffer?: unknown }).arrayBuffer === "function" &&
    "size" in v &&
    "type" in v
  );
}

export async function POST(request: Request): Promise<NextResponse> {
  // --- 第一層ゲート: 認証 + ADS_ROLES + 所属校（保存の前に弾く） ---
  const user = await getCurrentUser();
  if (!user) {
    return err(401, "unauthenticated");
  }
  if (!(ADS_ROLES as readonly string[]).includes(user.role)) {
    return err(403, "forbidden");
  }
  const schoolId = user.schoolId;
  if (!schoolId) {
    // テナント文脈を持たない system_admin は自校アップロード不可（school_admin への降格 = 対象校選択が要る）。
    return err(403, "forbidden");
  }

  // --- サイズ早期棄却（Content-Length。本体読込前） ---
  if (exceedsContentLength(request.headers.get("content-length"))) {
    return err(413, "file_too_large");
  }

  // --- multipart 解析（body ストリームをバイト上限付きで読みメモリ膨張を遮断） ---
  let form: FormData;
  try {
    form = await parseUploadForm(request);
  } catch (e) {
    if (e instanceof RequestTooLargeError) {
      return err(413, "file_too_large");
    }
    return err(400, "invalid_multipart");
  }
  const file = form.get("file");
  if (!isUploadFile(file)) {
    return err(400, "file_required");
  }

  // --- MIME allowlist（ext は MIME から導出） ---
  const type = resolveAdMediaUploadType(file.type);
  if (!type) {
    return err(415, "unsupported_media_type");
  }

  // --- 実バイト長の再検査（Content-Length 詐称対策） ---
  if (file.size > MAX_UPLOAD_BYTES) {
    return err(413, "file_too_large");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    return err(413, "file_too_large");
  }

  // --- 宣言 MIME と実バイト列の整合をマジックバイトで検証（偽装画像を保存前に弾く） ---
  if (!hasValidImageMagicBytes(bytes, file.type)) {
    return err(415, "unsupported_media_type");
  }

  // --- 公開 ad-media バケットへ保存（サーバ生成 UUID + per-school prefix） ---
  const objectKey = buildAdMediaObjectKey(schoolId, randomUUID(), type.ext);
  try {
    await getAdMediaUploadStorage().save(objectKey, Buffer.from(bytes), file.type);
  } catch {
    // バケット未配線 / ネットワーク障害等。フェイルクローズ（URL を返さない）。
    return err(502, "storage_unavailable");
  }

  // 同一オリジン配信 URL を返す。呼び出し側（AdsManager）が createAdAction の mediaUrl に渡す（監査はそこで成立）。
  return NextResponse.json(
    { url: adMediaServingPath(objectKey), mediaType: type.mediaType },
    { status: 201 },
  );
}
