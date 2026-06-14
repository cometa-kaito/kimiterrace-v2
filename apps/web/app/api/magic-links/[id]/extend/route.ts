import { extendMagicLink, withTenantContext } from "@kimiterrace/db";
import { NextResponse } from "next/server";
import { getDb } from "../../../../../lib/db";
import {
  requireIssuer,
  tenantContextForIssuer,
  toMagicLinkActor,
} from "../../../../../lib/magic-link/issuer";
import { computeExpiresAt, isUuid, parseExtendBody } from "../../../../../lib/magic-link/request";

/**
 * F05: クラス magic link の有効期限更新 API (ADR-008 / ADR-019)。
 *
 * `POST /api/magic-links/{id}/extend` body `{expiresInDays}` — 学校管理者 / 運営がリンクの有効期限を
 * 「**今 (サーバ時刻) から N 日後**」に張り直す (短縮・延長・期限切れの再有効化)。client 時刻は信用せず、
 * 発行 API と同じく `computeExpiresAt(days, new Date())` で起点をサーバ側に固定する。
 *
 * - 失効済リンクは更新不可 / 不可視・不存在は RLS で 404 (extendMagicLink が undefined)。
 * - 認可: `requireIssuer`（school_admin / system_admin。system_admin は cross-tenant で他校リンクも更新可）。
 */
export async function POST(
  request: Request,
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
  const updated = await withTenantContext(getDb(), tenantContextForIssuer(auth.issuer), (tx) =>
    extendMagicLink(tx, id, newExpiresAt, toMagicLinkActor(auth.issuer)),
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
