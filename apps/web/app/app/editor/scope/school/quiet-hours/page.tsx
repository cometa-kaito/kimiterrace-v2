import { requireRole } from "@/lib/auth/guard";
import { QUIET_HOURS_ROLES } from "@/lib/school-admin/quiet-hours-core";
import { ScopeQuietHoursView } from "../../ScopeQuietHoursView";

/** 学校全体スコープの静粛時間設定 `/app/editor/scope/school/quiet-hours`。配下の全クラスに継承表示。 */
export default async function SchoolQuietHoursPage() {
  // ページ本体でも委譲先 View と同じ集合で明示ガード (多層防御・棚卸し耐性)。
  await requireRole(QUIET_HOURS_ROLES);
  return <ScopeQuietHoursView target={{ scope: "school" }} />;
}
