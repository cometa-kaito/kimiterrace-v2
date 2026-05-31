import { requireRole } from "@/lib/auth/guard";
import { SYSTEM_ADMIN_ROLES } from "@/lib/system-admin/roles";
import Link from "next/link";
import { SchoolCreateForm } from "./_components/SchoolCreateForm";

/**
 * #48-L3 (#123): システム管理者の学校新規作成 (`/admin/system/schools/new`)。**Server Component**。
 *
 * **認可**: `/admin` layout の `requireRole(ADMIN_ROLES)` に加え `requireRole(SYSTEM_ADMIN_ROLES)`
 * (system_admin のみ)。テナント プロビジョニング (新規校作成) は横断運用なので system_admin 専用。
 * 入力収集は `SchoolCreateForm` (Client) → `createSchoolAction` (Server Action)。検証・認可・監査・
 * RLS WITH CHECK はアクション側が担保する。
 */
export default async function SystemSchoolNewPage() {
  await requireRole(SYSTEM_ADMIN_ROLES);

  return (
    <section
      style={{ display: "flex", flexDirection: "column", gap: "1.25rem", maxWidth: "640px" }}
    >
      <Link href="/admin/system/schools" style={backLinkStyle}>
        ← 学校一覧
      </Link>
      <h1 style={titleStyle}>学校を新規登録</h1>
      <SchoolCreateForm />
    </section>
  );
}

const backLinkStyle: React.CSSProperties = {
  fontSize: "0.85rem",
  color: "#2563eb",
  textDecoration: "none",
};
const titleStyle: React.CSSProperties = { fontSize: "1.4rem", fontWeight: 700, margin: 0 };
