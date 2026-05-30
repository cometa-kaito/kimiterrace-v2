import {
  TeacherInputValidationError,
  type TenantTx,
  deleteTeacherInput,
  getTeacherInput,
  saveDraft,
  submitTeacherInput,
  updateTranscript,
} from "@kimiterrace/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import { UnauthenticatedError, withSession } from "../../../../lib/db";

/**
 * F02: 教員入力 — 個別リソースエンドポイント (ADR-008 Route Handlers)。
 *
 * - GET    /api/teacher-inputs/:id        … 詳細
 * - PATCH  /api/teacher-inputs/:id        … action で分岐:
 *     - "edit_transcript" (FR-04): transcript 編集
 *     - "save_draft"      (FR-06): 下書き保存
 *     - "submit"          (FR-07): F03 へ送信 (status=submitted + submitted_at)
 * - DELETE /api/teacher-inputs/:id        … 削除 (添付メタは cascade)
 *
 * Next 16: 動的 params は Promise。`await context.params` で解決する。
 * 認証・RLS は withSession、未認証 401 / 不正 400 / 不在 404。
 */

type RouteContext = { params: Promise<{ id: string }> };

const idSchema = z.string().uuid();

const patchSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("edit_transcript"), transcript: z.string().max(20_000) }),
  z.object({
    action: z.literal("save_draft"),
    transcript: z.string().max(20_000).optional().nullable(),
    audioPath: z.string().max(2_000).optional().nullable(),
  }),
  z.object({ action: z.literal("submit") }),
]);

function unauth(): NextResponse {
  return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
}

export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  const { id } = await context.params;
  if (!idSchema.safeParse(id).success) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  try {
    const row = await withSession((tx: TenantTx) => getTeacherInput(tx, id));
    if (!row) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json(row);
  } catch (e) {
    if (e instanceof UnauthenticatedError) return unauth();
    throw e;
  }
}

export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
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
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const data = parsed.data;

  try {
    const result = await withSession(async (tx: TenantTx, user) => {
      switch (data.action) {
        case "edit_transcript":
          return await updateTranscript(tx, user.uid, id, { transcript: data.transcript });
        case "save_draft":
          return await saveDraft(tx, user.uid, id, {
            transcript: data.transcript,
            audioPath: data.audioPath,
          });
        case "submit":
          return await submitTeacherInput(tx, user.uid, id);
      }
    });
    if (!result) {
      // save_draft が submitted 済みで拒否したケースは 409、それ以外は 404。
      if (data.action === "save_draft") {
        return NextResponse.json({ error: "not_found_or_already_submitted" }, { status: 409 });
      }
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof UnauthenticatedError) return unauth();
    if (e instanceof TeacherInputValidationError) {
      return NextResponse.json({ error: "unprocessable", message: e.message }, { status: 422 });
    }
    throw e;
  }
}

export async function DELETE(_request: Request, context: RouteContext): Promise<NextResponse> {
  const { id } = await context.params;
  if (!idSchema.safeParse(id).success) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  try {
    const ok = await withSession((tx: TenantTx, user) => deleteTeacherInput(tx, user.uid, id));
    if (!ok) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ status: "deleted" });
  } catch (e) {
    if (e instanceof UnauthenticatedError) return unauth();
    throw e;
  }
}
