import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { getAdvertiserDetail } from "@/lib/system-admin/advertisers-queries";
import { SYSTEM_ADMIN_ROLES } from "@/lib/system-admin/roles";
import { isUuid } from "@/lib/system-admin/schools-core";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AdvertiserEditForm } from "./_components/AdvertiserEditForm";

/**
 * F10 (#46): 広告主のフィールド編集 (`/ops/advertisers/{id}/edit`)。**Server Component**。
 *
 * **認可**: `/admin` レイアウトの `requireRole(ADMIN_ROLES)` に加え `requireRole(SYSTEM_ADMIN_ROLES)`
 * (system_admin のみ)。広告主マスタ (CRM) は cross-tenant で system_admin 専用、school_admin / teacher は
 * 403 (`/forbidden`)。`withSession` の RLS tx で `getAdvertiserDetail` を取得 — 可視範囲は advertisers の
 * RLS が決め、不可視 / 不存在 / 不正 id は 404 (`notFound()`)。実際の UPDATE・検証・監査は
 * `updateAdvertiserAction` が担う。稼働状態 (is_active) の切替は一覧の稼働トグルが管轄で本画面では扱わない。
 */
export default async function EditAdvertiserPage({ params }: { params: Promise<{ id: string }> }) {
  await requireRole(SYSTEM_ADMIN_ROLES);
  const { id } = await params;
  if (!isUuid(id)) {
    notFound();
  }
  const advertiser = await withSession((tx) => getAdvertiserDetail(tx, id)).catch(() => null);
  if (!advertiser) {
    notFound();
  }

  return (
    <section
      style={{ display: "flex", flexDirection: "column", gap: "1.25rem", maxWidth: "32rem" }}
    >
      <Link href="/ops/advertisers" style={backLinkStyle}>
        ← 広告主一覧
      </Link>
      <h1 style={titleStyle}>広告主の編集</h1>
      <AdvertiserEditForm advertiser={advertiser} />
      {/* 商流SoR一元化 Phase1 (2026-06-13): 契約管理・コミュニケーション履歴の正本は portal に一元化した
          ため (実装設計書 §26/§42.2/§43)、v2 の重複ビュー (.../contracts, .../communications) への
          導線は撤去した。本画面は広告主フィールドの編集のみを担う。 */}
    </section>
  );
}

const backLinkStyle: React.CSSProperties = {
  fontSize: "0.85rem",
  color: "#2563eb",
  textDecoration: "none",
};
const titleStyle: React.CSSProperties = { fontSize: "1.3rem", fontWeight: 700, margin: 0 };
