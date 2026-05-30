import { revokeMagicLink, withTenantContext } from "@kimiterrace/db";
import { NextResponse } from "next/server";
import { getCurrentUser } from "../../../../../lib/auth/session";
import { getDb } from "../../../../../lib/db";
import { isIssuerRole, isUuid } from "../../../../../lib/magic-link/request";

/**
 * F05: クラス magic link の失効 API (ADR-008 / ADR-019)。
 *
 * `POST /api/magic-links/{id}/revoke` — 教員/学校管理者がリンクを即時失効。漏洩検知時の
 * 一次対応 (F05: 漏洩検知時の即時失効フロー)。失効後の生徒アクセスは 410 Gone になる
 * (resolve_magic_link が `revoked_at IS NULL` を要求するため)。冪等: 既に失効済 / 存在しない /
 * 他校のリンクはすべて 404 (RLS で他校行は不可視)。
 */

export async function POST(
  _request: Request,
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

  const revoked = await withTenantContext(
    getDb(),
    { userId: user.uid, schoolId: user.schoolId, role: user.role },
    (tx) => revokeMagicLink(tx, id, user.uid),
  );

  if (!revoked) {
    // 存在しない / 既に失効済 / 他校 (RLS で不可視)。冪等に 404。
    return NextResponse.json({ error: "not_found_or_already_revoked" }, { status: 404 });
  }

  return NextResponse.json({
    id: revoked.id,
    revokedAt: revoked.revokedAt?.toISOString() ?? null,
  });
}
