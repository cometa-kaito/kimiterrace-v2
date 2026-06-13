import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { SCHOOL_HIERARCHY_ROLES } from "@/lib/school-admin/hub-core";
import { getSchoolHierarchy } from "@/lib/school-admin/hub-queries";
import { HierarchyManager } from "./_components/HierarchyManager";

/**
 * 学校管理者ハブ (#48-K)。自校の学科 / 学年 / クラス階層の一覧 + 追加。
 *
 * `/admin` 配下なので #48-C layout の認証ゲートが掛かるが、本ページは更にロールを
 * `SCHOOL_HIERARCHY_ROLES` (school_admin / system_admin) に絞る (teacher は 403 → /forbidden)。
 * 階層データは `withSession` の自校 RLS tx で取得する (ルール2)。
 */
export default async function SchoolAdminHubPage() {
  await requireRole(SCHOOL_HIERARCHY_ROLES);
  const hierarchy = await withSession((tx) => getSchoolHierarchy(tx));
  return <HierarchyManager hierarchy={hierarchy} />;
}
