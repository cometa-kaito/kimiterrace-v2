import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { SYSTEM_ADMIN_ROLES } from "@/lib/system-admin/roles";
import { getOwnSensorDevice } from "@kimiterrace/db";
import { notFound, redirect } from "next/navigation";

/**
 * 旧 `/ops/sensors/[id]/edit` (全校共通の編集フォーム)。**Server Component**。
 *
 * ADR-041 D3 でセンサー編集は **対象校スコープ**になった (system_admin は targetSchoolId 明示で書く)。
 * 全校共通フォームは対象校を持たず実書き込みできないため、対象センサーの school_id を解決し、正規の
 * 対象校編集ページ `/ops/schools/{schoolId}/sensors/{id}/edit` へ恒久リダイレクトする (全校一覧 `/ops/sensors`
 * の行リンクも既に新ページを指す。本ページは旧 URL の互換のために残す)。
 *
 * **認可**: 一覧と同じく `requireRole(SYSTEM_ADMIN_ROLES)` (system_admin のみ)。`getOwnSensorDevice` は
 * RLS (system_admin_full_access) で全校可視のため school_id を解決でき、不存在 id は 404。
 */
export default async function EditSensorRedirectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireRole(SYSTEM_ADMIN_ROLES);
  const { id } = await params;

  const sensor = await withSession((tx) => getOwnSensorDevice(tx, id));
  if (!sensor) {
    notFound();
  }
  redirect(`/ops/schools/${sensor.schoolId}/sensors/${sensor.id}/edit`);
}
