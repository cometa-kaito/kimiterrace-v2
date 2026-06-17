import { requireRole } from "@/lib/auth/guard";
import { SYSTEM_ADMIN_ROLES } from "@/lib/system-admin/roles";
import { redirect } from "next/navigation";

/**
 * 旧 `/ops/sensors/new` (全校共通の登録フォーム)。**Server Component**。
 *
 * ADR-041 D3 でセンサー登録は **対象校スコープ**になった (system_admin は targetSchoolId 明示で書く、
 * ads/quiet_hours/editor と同型)。全校共通フォームは対象校を持たず実書き込みできないため、ここでは学校を
 * 選ぶ一覧 `/ops/schools` へ恒久リダイレクトする (各校の `/ops/schools/[id]/sensors` が正規の登録経路)。
 *
 * **認可**: 一覧と同じく `requireRole(SYSTEM_ADMIN_ROLES)` (system_admin のみ。teacher / school_admin は 403)。
 */
export default async function NewSensorRedirectPage() {
  await requireRole(SYSTEM_ADMIN_ROLES);
  redirect("/ops/schools");
}
