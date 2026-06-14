import { parseEditorTarget } from "@/lib/editor/schedule-core";
import { notFound } from "next/navigation";
import { ScopeAdsView } from "../../../ScopeAdsView";

/** 学年スコープの広告管理 `/app/editor/scope/grade/[id]/ads`。配下クラスに継承表示。 */
export default async function GradeAdsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const target = parseEditorTarget("grade", id);
  if (!target) {
    notFound();
  }
  return <ScopeAdsView target={target} />;
}
