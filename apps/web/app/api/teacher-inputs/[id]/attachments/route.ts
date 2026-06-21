import { type TenantTx, addAttachment, listAttachments } from "@kimiterrace/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import { ForbiddenError, UnauthenticatedError, withSession } from "../../../../../lib/db";
import { isWithinSchoolUploadPrefix } from "../../../../../lib/storage/upload-storage";
import { TEACHER_INPUT_STAFF_ROLES } from "../../../../../lib/teacher-input/roles";
import { resolveUploadType } from "../../../../../lib/teacher-input/upload-validation";

/**
 * F02 (FR-05): 教員入力の添付メタエンドポイント (ADR-008 Route Handlers)。
 *
 * - GET  /api/teacher-inputs/:id/attachments  … 添付メタ一覧
 * - POST /api/teacher-inputs/:id/attachments  … 添付メタ登録
 *     クライアントが `POST /api/teacher-inputs/upload`（実体保存・MIME/サイズ/マジックバイト検証済み）で
 *     得た自校 object path を、既存 input に追加 attachment として紐づける。
 *
 * セキュリティ（ルール2 多層防御）:
 * - **二層認可**: `allowedRoles` で staff role 以外を 403 (生徒/保護者/system_admin 排除) + RLS。
 * - **MIME allowlist**: 申告 `mimeType` を upload と同じ allowlist（`resolveUploadType`）に限定（415）。
 * - **越境登録防止**: 申告 `storagePath` を自校 prefix `uploads/{schoolId}/` 内に限定（403）。GCS は RLS を
 *   尊重しないため、他校 object path の登録 → `listAttachments`/DL での cross-tenant 読取を構造的に塞ぐ。
 *
 * TODO(別 PR・インフラ要): クライアントへの署名付きアップロード URL 直接発行と、保存オブジェクトの
 *   ウイルススキャン（GCS トリガ → スキャナ。Terraform 管理・ルール8）は本ルートのスコープ外。
 *
 * Next 16: 動的 params は Promise。認証・RLS は withSession。
 */

type RouteContext = { params: Promise<{ id: string }> };

const idSchema = z.string().uuid();
const createSchema = z.object({
  storagePath: z.string().min(1).max(2_000),
  mimeType: z.string().min(1).max(255),
});

function unauth(): NextResponse {
  return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
}

function forbidden(): NextResponse {
  return NextResponse.json({ error: "forbidden" }, { status: 403 });
}

export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  const { id } = await context.params;
  if (!idSchema.safeParse(id).success) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  try {
    const rows = await withSession((tx: TenantTx) => listAttachments(tx, id), {
      allowedRoles: TEACHER_INPUT_STAFF_ROLES,
    });
    return NextResponse.json({ items: rows });
  } catch (e) {
    if (e instanceof UnauthenticatedError) return unauth();
    if (e instanceof ForbiddenError) return forbidden();
    throw e;
  }
}

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  const { id } = await context.params;
  if (!idSchema.safeParse(id).success) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // 申告 MIME を upload と同じ allowlist に限定（実行可能・スクリプト等の登録を拒否）。
  if (!resolveUploadType(parsed.data.mimeType)) {
    return NextResponse.json({ error: "unsupported_media_type" }, { status: 415 });
  }

  try {
    const row = await withSession(
      (tx: TenantTx, user) => {
        // 越境登録防止: 申告 storagePath は自校 prefix (uploads/{schoolId}/) 内に限る。
        // 認可ゲート(allowedRoles)通過後に user.schoolId で検証する（クライアント由来 path を信頼しない）。
        if (!isWithinSchoolUploadPrefix(parsed.data.storagePath, user.schoolId)) {
          throw new ForbiddenError();
        }
        return addAttachment(tx, user.uid, id, parsed.data);
      },
      { allowedRoles: TEACHER_INPUT_STAFF_ROLES },
    );
    if (!row) {
      return NextResponse.json({ error: "input_not_found" }, { status: 404 });
    }
    return NextResponse.json(row, { status: 201 });
  } catch (e) {
    if (e instanceof UnauthenticatedError) return unauth();
    if (e instanceof ForbiddenError) return forbidden();
    throw e;
  }
}
