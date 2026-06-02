import { randomUUID } from "node:crypto";
import { type TenantTx, addAttachment, createTeacherInput } from "@kimiterrace/db";
import {
  ExtractFailedError,
  ExtractorNotConfiguredError,
  UnsupportedFormatError,
  extractText,
} from "@kimiterrace/ai";
import { NextResponse } from "next/server";
import { getCurrentUser } from "../../../../lib/auth/session";
import { ForbiddenError, UnauthenticatedError, withSession } from "../../../../lib/db";
import { buildUploadObjectPath, getUploadStorage } from "../../../../lib/storage/upload-storage";
import { TEACHER_INPUT_STAFF_ROLES, isTeacherInputRole } from "../../../../lib/teacher-input/roles";
import {
  MAX_UPLOAD_BYTES,
  exceedsContentLength,
  resolveUploadType,
} from "../../../../lib/teacher-input/upload-validation";

/**
 * F01 (#509 S2b): 教員ファイルアップロード取り込み `POST /api/teacher-inputs/upload`。
 *
 * multipart の `file` フィールドを受け、PDF/DOCX/XLSX/PNG/JPEG を Cloud Storage に保存して
 * `teacher_inputs(input_type='file')` + `teacher_input_attachments` 行を作成する。可能なら抽出器で
 * 本文をテキスト化して transcript に格納（画像は OCR 配線後＝ADR-024 決定3 のため pending）。
 *
 * セキュリティ（NFR03 / ルール）:
 * - **二層認可**（ルール2）: getCurrentUser で staff role + 所属校を先に確認（GCS 保存前にゲート）し、
 *   DB 書込は `withSession({allowedRoles})` で再ゲート + RLS。生徒/保護者/system_admin は弾く。
 * - **MIME allowlist + 50MB 上限**（NFR03）: Content-Length 早期棄却 + 実バイト長の二段。
 * - **保存キーはサーバ生成 UUID + MIME 由来拡張子**: クライアントのファイル名を path に使わない
 *   （path traversal 不能）。per-school prefix で cross-tenant object を構造防止（PR #516 Reviewer Medium）。
 * - **監査**（ルール1）: createTeacherInput / addAttachment が同一 tx で audit_log に insert を記録。
 * - **ルール5**: GCS 認証は ADC（Workload Identity）、バケット名は env、JSON キーなし。
 *
 * Vertex への構造化抽出（schedule/announcement 等）と編集→公開は後続 S3。本ルートは取り込み + 本文テキスト化まで。
 */

export const runtime = "nodejs";

function err(status: number, error: string): NextResponse {
  return NextResponse.json({ error }, { status });
}

/** formData.get の戻り（File | string | null）から File 的オブジェクトだけ受ける duck-type ガード。 */
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
  // --- 第一層ゲート: 認証 + staff role + 所属校（重い抽出/保存の前に弾く） ---
  const user = await getCurrentUser();
  if (!user) {
    return err(401, "unauthenticated");
  }
  if (!isTeacherInputRole(user.role)) {
    return err(403, "forbidden");
  }
  const schoolId = user.schoolId;
  if (!schoolId) {
    // system_admin はテナント文脈を持たない → 自校アップロード不可
    return err(403, "forbidden");
  }

  // --- サイズ早期棄却（Content-Length。本体読込前） ---
  if (exceedsContentLength(request.headers.get("content-length"))) {
    return err(413, "file_too_large");
  }

  // --- multipart 解析 ---
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return err(400, "invalid_multipart");
  }
  const file = form.get("file");
  if (!isUploadFile(file)) {
    return err(400, "file_required");
  }

  // --- MIME allowlist（拡張子はファイル名でなく MIME から導出） ---
  const type = resolveUploadType(file.type);
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

  // --- 本文テキスト化（@kimiterrace/ai 抽出器。Vertex 未経由） ---
  let transcript: string | null = null;
  let inputStatus: "ready" | "transcribing" = "transcribing";
  let extraction: "extracted" | "pending_ocr" = "pending_ocr";
  try {
    const result = await extractText({ bytes, mimeType: file.type, filename: file.name });
    transcript = result.text;
    inputStatus = "ready";
    extraction = "extracted";
  } catch (e) {
    if (e instanceof ExtractorNotConfiguredError) {
      // 画像 OCR 未配線（ADR-024 決定3）。アップロードは受理し、テキスト化は OCR 配線後に保留。
      extraction = "pending_ocr";
    } else if (e instanceof ExtractFailedError) {
      // 破損 / 暗号化 / 非対応サブ形式（フェイルクローズ）。何も保存しない。
      return err(422, "extraction_failed");
    } else if (e instanceof UnsupportedFormatError) {
      // allowlist で弾けているはずだが念のため（保存しない）。
      return err(415, "unsupported_media_type");
    } else {
      throw e;
    }
  }

  // --- Cloud Storage 保存（サーバ生成 UUID + per-school prefix） ---
  const objectPath = buildUploadObjectPath(schoolId, randomUUID(), type.ext);
  try {
    await getUploadStorage().save(objectPath, Buffer.from(bytes), file.type);
  } catch {
    // バケット未有効化 / ネットワーク障害等。フェイルクローズ（DB 行を作らない）。
    return err(502, "storage_unavailable");
  }

  // --- DB 行作成（同一 tx・RLS・監査）。第二層ゲートで role 再確認 ---
  try {
    const created = await withSession(
      async (tx: TenantTx, u) => {
        const input = await createTeacherInput(tx, schoolId, u.uid, {
          inputType: "file",
          transcript,
          status: inputStatus,
        });
        const attachment = await addAttachment(tx, u.uid, input.id, {
          storagePath: objectPath,
          mimeType: file.type,
        });
        return { input, attachment };
      },
      { allowedRoles: TEACHER_INPUT_STAFF_ROLES },
    );
    if (!created.attachment) {
      // 直前に作成した input が見つからない（理論上起きない）。
      return err(500, "attachment_failed");
    }
    return NextResponse.json(
      { input: created.input, attachment: created.attachment, extraction: { status: extraction } },
      { status: 201 },
    );
  } catch (e) {
    if (e instanceof UnauthenticatedError) return err(401, "unauthenticated");
    if (e instanceof ForbiddenError) return err(403, "forbidden");
    throw e;
  }
}
