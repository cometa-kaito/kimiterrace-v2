import type { MagicLinkActor, TenantContext, TenantRole } from "@kimiterrace/db";
import { NextResponse } from "next/server";
import { getCurrentUser } from "../auth/session";
import { isIssuerRole } from "./request";

/**
 * F05: magic link 発行/失効/延長 API の**発行者ロール認可と RLS context 解決**（server 専用・3 ルート共有）。
 *
 * `POST /api/magic-links`・`/{id}/revoke`・`/{id}/extend` で同一に振る舞わせるため、認可と context/actor の
 * 導出をここに集約する（ドリフト防止）。発行者 = **school_admin / system_admin のみ**（teacher 除外・指摘ログ
 * finding④）。認可は二層: ここで role を弾く（早期 deny）+ DB の `tenant_isolation` / `system_admin_full_access`
 * が school 越境を DB レベルで制御する（ルール2 多層防御）。
 *
 * **system_admin（cross-tenant 運用者）の扱い**: school に属さない（schoolId=null）ため、
 * - context は **role のみ SET**（`system_admin_full_access` policy が任意校を許可。uid は `users` 行でないので
 *   app.current_user_id に載せない）。
 * - 監査 actor は **userId=null + IdP uid を identityUid** に載せる（FK 列に system_admin を入れられないため。
 *   config-edit / schools-actions と同型・ルール1）。
 */

/** 認可済み発行者。system_admin は `schoolId=null`（操作対象から学校を解決する）。 */
export type Issuer = { uid: string; schoolId: string | null; role: TenantRole };

/** 認証 + 発行者ロールを確認し、未認証/権限不足なら NextResponse、OK なら issuer を返す。 */
export async function requireIssuer(): Promise<
  { ok: true; issuer: Issuer } | { ok: false; response: NextResponse }
> {
  const user = await getCurrentUser();
  if (!user) {
    return {
      ok: false,
      response: NextResponse.json({ error: "unauthenticated" }, { status: 401 }),
    };
  }
  // 発行者ロール以外は 403。さらに system_admin 以外（school_admin）は schoolId 必須（テナント所属）。
  // system_admin は schoolId=null を許可し、操作対象（クラス/リンク）の学校は RLS / 解決で扱う。
  if (!isIssuerRole(user.role) || (user.role !== "system_admin" && !user.schoolId)) {
    return { ok: false, response: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  }
  return {
    ok: true,
    issuer: { uid: user.uid, schoolId: user.schoolId ?? null, role: user.role },
  };
}

/**
 * 発行者の RLS context。**system_admin は role のみ SET**（school スコープを張らず `system_admin_full_access`
 * が任意校を許可。uid は `users` 行でないため app.current_user_id に載せない）。school_admin は自校 context。
 */
export function tenantContextForIssuer(issuer: Issuer): TenantContext {
  if (issuer.role === "system_admin") {
    return { role: "system_admin" };
  }
  return { userId: issuer.uid, schoolId: issuer.schoolId, role: issuer.role };
}

/** 監査 actor。system_admin は `users` 行でないため userId=null・IdP uid を identityUid に載せる（ルール1）。 */
export function toMagicLinkActor(issuer: Issuer): MagicLinkActor {
  return issuer.role === "system_admin"
    ? { userId: null, identityUid: issuer.uid }
    : { userId: issuer.uid, identityUid: issuer.uid };
}
