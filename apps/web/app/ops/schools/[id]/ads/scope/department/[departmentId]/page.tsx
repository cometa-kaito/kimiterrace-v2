import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { parseEditorTarget } from "@/lib/editor/schedule-core";
import { SYSTEM_ADMIN_ROLES } from "@/lib/system-admin/roles";
import { isUuid } from "@/lib/system-admin/schools-core";
import { getSchoolDetail } from "@kimiterrace/db";
import { notFound } from "next/navigation";
import { OpsScopeAdsView } from "../../../../_components/OpsScopeAdsView";

/**
 * システム管理者が**特定校の学科スコープ**の広告を編集する画面
 * (`/ops/schools/{id}/ads/scope/department/{departmentId}`)。**Server Component**。
 * `/ops/schools/{id}/ads`（掲載先ピッカー）の学科一覧からの遷移先。ここに掲載した広告は当該学科配下の学年 /
 * クラスのサイネージに継承表示される（一括掲載）。処理本体は {@link OpsScopeAdsView} に集約（対象校 RLS tx で
 * 学科の可視性を確認、他校 id は 404）。
 *
 * **認可**: `/ops` layout の `requireRole(ADMIN_ROLES)` に加え `requireRole(SYSTEM_ADMIN_ROLES)`（多層防御・棚卸し
 * 耐性で委譲先ビューと同じ集合をページ本体でも直接ガード）。校名・存在確認は全校読取の `getSchoolDetail`、
 * 不正 / 不存在 id は 404。
 */
export default async function SystemSchoolDepartmentAdsPage({
  params,
}: {
  params: Promise<{ id: string; departmentId: string }>;
}) {
  await requireRole(SYSTEM_ADMIN_ROLES);
  const { id, departmentId } = await params;
  if (!isUuid(id)) {
    notFound();
  }
  const target = parseEditorTarget("department", departmentId);
  if (!target) {
    notFound();
  }
  // 校名・存在確認 (system_admin の全校読取、tenantScoped なし)。不存在 / 不可視は 404。
  const detail = await withSession((tx) => getSchoolDetail(tx, id)).catch(() => null);
  if (!detail) {
    notFound();
  }
  return (
    <OpsScopeAdsView schoolId={detail.school.id} schoolName={detail.school.name} target={target} />
  );
}
