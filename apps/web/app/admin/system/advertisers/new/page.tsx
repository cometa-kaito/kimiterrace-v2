import { requireRole } from "@/lib/auth/guard";
import { SYSTEM_ADMIN_ROLES } from "@/lib/system-admin/roles";
import Link from "next/link";
import { AdvertiserCreateForm } from "./_components/AdvertiserCreateForm";

/**
 * F10 (#46): 広告主の新規登録 (`/admin/system/advertisers/new`)。**Server Component**。
 *
 * **認可**: `/admin` レイアウトの `requireRole(ADMIN_ROLES)` に加え `requireRole(SYSTEM_ADMIN_ROLES)`
 * (system_admin のみ)。広告主マスタ (CRM) は cross-tenant で system_admin 専用、school_admin / teacher は
 * 403 (`/forbidden`)。実際の INSERT・検証・監査・RLS WITH CHECK は `createAdvertiserAction` が担う。
 */
export default async function NewAdvertiserPage() {
  await requireRole(SYSTEM_ADMIN_ROLES);

  return (
    <section
      style={{ display: "flex", flexDirection: "column", gap: "1.25rem", maxWidth: "32rem" }}
    >
      <Link href="/admin/system/advertisers" style={backLinkStyle}>
        ← 広告主一覧
      </Link>
      <h1 style={titleStyle}>広告主の新規登録</h1>
      <AdvertiserCreateForm />
    </section>
  );
}

const backLinkStyle: React.CSSProperties = {
  fontSize: "0.85rem",
  color: "#2563eb",
  textDecoration: "none",
};
const titleStyle: React.CSSProperties = { fontSize: "1.3rem", fontWeight: 700, margin: 0 };
