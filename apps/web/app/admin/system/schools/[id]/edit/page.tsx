import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { SYSTEM_ADMIN_ROLES } from "@/lib/system-admin/roles";
import { isUuid } from "@/lib/system-admin/schools-core";
import { getSchool } from "@kimiterrace/db";
import { notFound } from "next/navigation";
import { SchoolEditForm } from "./_components/SchoolEditForm";

/**
 * #48-L (#123): システム管理者の学校編集 (`/admin/system/schools/{id}/edit`)。**Server Component**。
 *
 * **認可**: `/admin` layout の `requireRole(ADMIN_ROLES)` に加え `requireRole(SYSTEM_ADMIN_ROLES)`
 * (system_admin のみ)。school_admin / teacher は 403 (`/forbidden`)。
 *
 * 対象校は `withSession` の RLS tx で `getSchool` 取得する。可視範囲は schools の RLS が決め
 * (system_admin=全校)、不可視 (他校 / 不存在 / 不正 id) は 404 (`notFound()`)。編集 (update) は
 * `SchoolEditForm` (Client) → `updateSchoolAction` (Server Action) で行う。
 */
export default async function SystemSchoolEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireRole(SYSTEM_ADMIN_ROLES);
  const { id } = await params;
  if (!isUuid(id)) {
    notFound();
  }
  const school = await withSession((tx) => getSchool(tx, id));
  if (!school) {
    notFound();
  }

  return (
    <section style={{ maxWidth: "560px" }}>
      <h1 style={{ fontSize: "1.3rem", fontWeight: 700, marginBottom: "1rem" }}>学校を編集</h1>
      <SchoolEditForm school={school} />
    </section>
  );
}
