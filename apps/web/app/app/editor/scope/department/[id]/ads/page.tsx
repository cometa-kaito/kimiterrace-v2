import { requireRole } from "@/lib/auth/guard";
import { parseEditorTarget } from "@/lib/editor/schedule-core";
import { ADS_ROLES } from "@/lib/school-admin/ads-core";
import { notFound } from "next/navigation";
import { ScopeAdsView } from "../../../ScopeAdsView";

/** 学科スコープの広告管理 `/app/editor/scope/department/[id]/ads`。配下学年/クラスに継承表示。 */
export default async function DepartmentAdsPage({ params }: { params: Promise<{ id: string }> }) {
  // ページ本体でも委譲先 View と同じ集合で明示ガード (多層防御・棚卸し耐性)。
  await requireRole(ADS_ROLES);
  const { id } = await params;
  const target = parseEditorTarget("department", id);
  if (!target) {
    notFound();
  }
  return <ScopeAdsView target={target} />;
}
