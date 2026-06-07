import { ScopeQuietHoursView } from "../../ScopeQuietHoursView";

/** 学校全体スコープの静粛時間設定 `/admin/editor/scope/school/quiet-hours`。配下の全クラスに継承表示。 */
export default function SchoolQuietHoursPage() {
  return <ScopeQuietHoursView target={{ scope: "school" }} />;
}
