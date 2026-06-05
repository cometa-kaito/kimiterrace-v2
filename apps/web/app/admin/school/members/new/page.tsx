import { requireRole } from "@/lib/auth/guard";
import { MEMBER_ADMIN_ROLES } from "@/lib/role-management/roles";
import Link from "next/link";
import { StaffCreateForm } from "./_components/StaffCreateForm";

/**
 * F11 (#508): 新規 teacher 発行 (`/admin/school/members/new`)。**Server Component**。
 *
 * **認可**: `/admin` レイアウトの `requireRole(ADMIN_ROLES)` に加え `requireRole(MEMBER_ADMIN_ROLES)`
 * (school_admin のみ)。teacher / system_admin は 403 (`/forbidden`)。実際の IdP 作成・DB INSERT・検証・
 * 監査・RLS WITH CHECK は `createStaffAction` が担う。本ページは発行者専用 nav の死リンク防止と整合。
 */
export default async function NewStaffPage() {
  await requireRole(MEMBER_ADMIN_ROLES);

  return (
    <section
      style={{ display: "flex", flexDirection: "column", gap: "1.25rem", maxWidth: "32rem" }}
    >
      <Link href="/admin/school/members" style={backLinkStyle}>
        ← 教職員一覧
      </Link>
      <h1 style={titleStyle}>教員アカウントの発行</h1>
      <StaffCreateForm />
    </section>
  );
}

const backLinkStyle: React.CSSProperties = {
  fontSize: "0.85rem",
  color: "#2563eb",
  textDecoration: "none",
};
const titleStyle: React.CSSProperties = { fontSize: "1.3rem", fontWeight: 700, margin: 0 };
