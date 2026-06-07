import { ScopeAdsView } from "../../ScopeAdsView";

/** 学校全体スコープの広告管理 `/admin/editor/scope/school/ads`。配下の全クラスに継承表示される。 */
export default function SchoolAdsPage() {
  return <ScopeAdsView target={{ scope: "school" }} />;
}
