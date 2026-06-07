import { parseEditorTarget } from "@/lib/editor/schedule-core";
import { notFound } from "next/navigation";
import { ScopeAdsView } from "../../../ScopeAdsView";

/** 学科スコープの広告管理 `/admin/editor/scope/department/[id]/ads`。配下学年/クラスに継承表示。 */
export default async function DepartmentAdsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const target = parseEditorTarget("department", id);
  if (!target) {
    notFound();
  }
  return <ScopeAdsView target={target} />;
}
