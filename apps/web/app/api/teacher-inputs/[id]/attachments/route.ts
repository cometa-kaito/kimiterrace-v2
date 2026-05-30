import { type TenantTx, addAttachment, listAttachments } from "@kimiterrace/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import { ForbiddenError, UnauthenticatedError, withSession } from "../../../../../lib/db";
import { TEACHER_INPUT_STAFF_ROLES } from "../../../../../lib/teacher-input/roles";

/**
 * F02 (FR-05, メタ行のみ): 教員入力の添付メタエンドポイント (ADR-008 Route Handlers)。
 *
 * - GET  /api/teacher-inputs/:id/attachments  … 添付メタ一覧
 * - POST /api/teacher-inputs/:id/attachments  … 添付メタ登録
 *     クライアントが別経路で Cloud Storage にアップロード済みの storage_path を登録するだけ。
 *
 * TODO(添付実体): 署名付き URL 発行・実アップロード・MIME 検証・ウイルススキャンは別 PR。
 *
 * Next 16: 動的 params は Promise。認証・RLS は withSession。
 * **認可は二層** (ルール2): `allowedRoles` で staff role 以外を 403 (生徒/保護者排除) + RLS。
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

  try {
    const row = await withSession(
      (tx: TenantTx, user) => addAttachment(tx, user.uid, id, parsed.data),
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
