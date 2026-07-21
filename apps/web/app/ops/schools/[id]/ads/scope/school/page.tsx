import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { SYSTEM_ADMIN_ROLES } from "@/lib/system-admin/roles";
import { isUuid } from "@/lib/system-admin/schools-core";
import { getSchoolDetail } from "@kimiterrace/db";
import { notFound } from "next/navigation";
import { OpsScopeAdsView } from "../../../_components/OpsScopeAdsView";

/**
 * システム管理者が**特定校の学校全体スコープ**の広告を編集する画面 (`/ops/schools/{id}/ads/scope/school`)。
 * **Server Component**。`/ops/schools/{id}/ads`（掲載先ピッカー）の「学校全体」からの遷移先。ここに掲載した広告は
 * 配下の全クラスのサイネージに継承表示される（一括掲載）。処理本体は {@link OpsScopeAdsView} に集約。
 *
 * **認可**: `/ops` layout の `requireRole(ADMIN_ROLES)` に加え `requireRole(SYSTEM_ADMIN_ROLES)`（多層防御・棚卸し
 * 耐性で委譲先ビューと同じ集合をページ本体でも直接ガード）。校名・存在確認は全校読取の `getSchoolDetail`、
 * 不正 / 不存在 id は 404。
 */
export default async function SystemSchoolWideAdsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireRole(SYSTEM_ADMIN_ROLES);
  const { id } = await params;
  if (!isUuid(id)) {
    notFound();
  }
  // 校名・存在確認 (system_admin の全校読取、tenantScoped なし)。不存在 / 不可視は 404。
  const detail = await withSession((tx) => getSchoolDetail(tx, id)).catch(() => null);
  if (!detail) {
    notFound();
  }
  return (
    <OpsScopeAdsView
      schoolId={detail.school.id}
      schoolName={detail.school.name}
      target={{ scope: "school" }}
    />
  );
}
