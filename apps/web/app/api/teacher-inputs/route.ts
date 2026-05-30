import { type TenantTx, createTeacherInput, listTeacherInputs } from "@kimiterrace/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import { UnauthenticatedError, withSession } from "../../../lib/db";

/**
 * F02: 教員音声 / チャット入力 — コレクションエンドポイント (ADR-008 Route Handlers)。
 *
 * - GET  /api/teacher-inputs       … FR-08 履歴一覧 (RLS で自校のみ)
 * - POST /api/teacher-inputs       … 入力作成 (chat ドラフト / voice 文字起こし待ちドラフト)
 *
 * 認証・RLS context は `withSession` が一元処理する (lib/db.ts → withTenantContext)。
 * 未認証は 401、入力不正は 400。監査は ドメイン層 (queries/teacher-inputs) が記録する。
 */

const createSchema = z.object({
  inputType: z.enum(["voice", "chat"]),
  transcript: z.string().max(20_000).optional().nullable(),
  audioPath: z.string().max(2_000).optional().nullable(),
  status: z.enum(["draft", "transcribing", "ready", "submitted"]).optional(),
});

/** テナント所属の無いユーザー (system_admin) がテナント内作成を試みた場合。 */
class NoSchoolContextError extends Error {}

export async function GET(): Promise<NextResponse> {
  try {
    const rows = await withSession((tx: TenantTx) => listTeacherInputs(tx));
    return NextResponse.json({ items: rows });
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    throw e;
  }
}

export async function POST(request: Request): Promise<NextResponse> {
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
    const row = await withSession(async (tx: TenantTx, user) => {
      // system_admin は school に属さないため作成不可 (テナント所属が必要)。
      if (!user.schoolId) {
        throw new NoSchoolContextError();
      }
      return await createTeacherInput(tx, user.schoolId, user.uid, parsed.data);
    });
    return NextResponse.json(row, { status: 201 });
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    if (e instanceof NoSchoolContextError) {
      return NextResponse.json({ error: "no_school_context" }, { status: 403 });
    }
    throw e;
  }
}
