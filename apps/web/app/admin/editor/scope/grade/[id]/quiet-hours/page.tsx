import { parseEditorTarget } from "@/lib/editor/schedule-core";
import { notFound } from "next/navigation";
import { ScopeQuietHoursView } from "../../../ScopeQuietHoursView";

/** 学年スコープの静粛時間設定 `/admin/editor/scope/grade/[id]/quiet-hours`。配下クラスに継承表示。 */
export default async function GradeQuietHoursPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const target = parseEditorTarget("grade", id);
  if (!target) {
    notFound();
  }
  return <ScopeQuietHoursView target={target} />;
}
