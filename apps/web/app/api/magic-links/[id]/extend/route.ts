import { extendMagicLink, withTenantContext } from "@kimiterrace/db";
import { NextResponse } from "next/server";
import { getCurrentUser } from "../../../../../lib/auth/session";
import { getDb } from "../../../../../lib/db";
import {
  computeExpiresAt,
  isIssuerRole,
  isUuid,
  parseExtendBody,
} from "../../../../../lib/magic-link/request";

/**
 * F05: クラス magic link の有効期限更新 API (ADR-008 / ADR-019)。
 *
 * `POST /api/magic-links/{id}/extend` body `{expiresInDays}` — 教員/学校管理者がリンクの
 * 有効期限を「**今 (サーバ時刻) から N 日後**」に張り直す (短縮・延長・期限切れの再有効化)。
 * client 時刻は信用せず、発行 API と同じく `computeExpiresAt(days, new Date())` で起点を
 * サーバ側に固定する。
 *
 * - 失効済リンクは更新不可 / 他校・不存在は RLS で不可視 → いずれも 404 (extendMagicLink が undefined)。
 * - 認可: `isIssuerRole` (teacher / school_admin) かつ schoolId 必須 (system_admin は不可)。
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  if (!isIssuerRole(user.role) || !user.schoolId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { id } = await context.params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const parsed = parseExtendBody(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const newExpiresAt = computeExpiresAt(parsed.value.expiresInDays, new Date());
  const updated = await withTenantContext(
    getDb(),
    { userId: user.uid, schoolId: user.schoolId, role: user.role },
    (tx) => extendMagicLink(tx, id, newExpiresAt, user.uid),
  );

  if (!updated) {
    // 存在しない / 失効済 / 他校 (RLS で不可視)。404。
    return NextResponse.json({ error: "not_found_or_revoked" }, { status: 404 });
  }

  return NextResponse.json({
    id: updated.id,
    expiresAt: updated.expiresAt.toISOString(),
  });
}
