import { requireRole } from "@/lib/auth/guard";
import { ADS_ROLES } from "@/lib/school-admin/ads-core";
import { ScopeAdsView } from "../../ScopeAdsView";

/** 学校全体スコープの広告管理 `/app/editor/scope/school/ads`。配下の全クラスに継承表示される。 */
export default async function SchoolAdsPage() {
  // ページ本体でも委譲先 View と同じ集合で明示ガード (多層防御・棚卸し耐性)。
  await requireRole(ADS_ROLES);
  return <ScopeAdsView target={{ scope: "school" }} />;
}
