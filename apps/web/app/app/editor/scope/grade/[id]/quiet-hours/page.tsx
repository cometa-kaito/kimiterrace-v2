import { requireRole } from "@/lib/auth/guard";
import { parseEditorTarget } from "@/lib/editor/schedule-core";
import { QUIET_HOURS_ROLES } from "@/lib/school-admin/quiet-hours-core";
import { notFound } from "next/navigation";
import { ScopeQuietHoursView } from "../../../ScopeQuietHoursView";

/** 学年スコープの静粛時間設定 `/app/editor/scope/grade/[id]/quiet-hours`。配下クラスに継承表示。 */
export default async function GradeQuietHoursPage({ params }: { params: Promise<{ id: string }> }) {
  // ページ本体でも委譲先 View と同じ集合で明示ガード (多層防御・棚卸し耐性)。
  await requireRole(QUIET_HOURS_ROLES);
  const { id } = await params;
  const target = parseEditorTarget("grade", id);
  if (!target) {
    notFound();
  }
  return <ScopeQuietHoursView target={target} />;
}
