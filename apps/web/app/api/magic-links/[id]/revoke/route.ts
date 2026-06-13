import { revokeMagicLink, withTenantContext } from "@kimiterrace/db";
import { NextResponse } from "next/server";
import { getDb } from "../../../../../lib/db";
import {
  requireIssuer,
  tenantContextForIssuer,
  toMagicLinkActor,
} from "../../../../../lib/magic-link/issuer";
import { isUuid } from "../../../../../lib/magic-link/request";

/**
 * F05: クラス magic link の失効 API (ADR-008 / ADR-019)。
 *
 * `POST /api/magic-links/{id}/revoke` — 学校管理者 / 運営がリンクを即時失効。漏洩検知時の一次対応
 * (F05)。失効後の生徒アクセスは 410 Gone になる (resolve_magic_link が `revoked_at IS NULL` を要求)。
 * 冪等: 既に失効済 / 存在しない / 不可視のリンクはすべて 404。認可は `requireIssuer`（school_admin /
 * system_admin。system_admin は cross-tenant・`system_admin_full_access` で他校リンクも失効可）。
 */

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const auth = await requireIssuer();
  if (!auth.ok) {
    return auth.response;
  }

  const { id } = await context.params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const revoked = await withTenantContext(getDb(), tenantContextForIssuer(auth.issuer), (tx) =>
    revokeMagicLink(tx, id, toMagicLinkActor(auth.issuer)),
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
