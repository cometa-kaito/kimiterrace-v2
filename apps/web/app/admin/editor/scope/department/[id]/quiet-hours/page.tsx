import { parseEditorTarget } from "@/lib/editor/schedule-core";
import { notFound } from "next/navigation";
import { ScopeQuietHoursView } from "../../../ScopeQuietHoursView";

/** 学科スコープの静粛時間設定 `/admin/editor/scope/department/[id]/quiet-hours`。配下に継承表示。 */
export default async function DepartmentQuietHoursPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const target = parseEditorTarget("department", id);
  if (!target) {
    notFound();
  }
  return <ScopeQuietHoursView target={target} />;
}
