import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { getAdvertiserDetail } from "@/lib/system-admin/advertisers-queries";
import { COMMUNICATION_CHANNEL_LABEL } from "@/lib/system-admin/communications-core";
import { listCommunicationsByAdvertiser } from "@/lib/system-admin/communications-queries";
import { SYSTEM_ADMIN_ROLES } from "@/lib/system-admin/roles";
import { isUuid } from "@/lib/system-admin/schools-core";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CommunicationCreateForm } from "./_components/CommunicationCreateForm";

/**
 * F10 (#46): ある広告主のコミュニケーション履歴一覧 + 新規登録
 * (`/admin/system/advertisers/{id}/communications`)。**Server Component**。
 *
 * **認可**: `requireRole(SYSTEM_ADMIN_ROLES)` (system_admin のみ、コミュニケーションは cross-tenant の
 * 営業データで contracts と同区分)。`withSession` の RLS tx で広告主詳細 (見出し用) + 履歴一覧を取得 —
 * 可視範囲は communications の RLS (`system_admin_full_access`) が決め、不可視 / 不存在 / 不正 id は 404。
 * 作成・検証・監査・RLS WITH CHECK は `createCommunicationAction` が担う (本画面は表示 + 作成フォーム)。
 */

/** Date を JST の YYYY/MM/DD HH:mm で表示する (サーバー描画、ロケール非依存に固定)。 */
function formatJstDateTime(value: Date): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(value);
}

export default async function AdvertiserCommunicationsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireRole(SYSTEM_ADMIN_ROLES);
  const { id } = await params;
  if (!isUuid(id)) {
    notFound();
  }
  const data = await withSession(async (tx) => {
    const advertiser = await getAdvertiserDetail(tx, id);
    if (!advertiser) {
      return null;
    }
    const communications = await listCommunicationsByAdvertiser(tx, id);
    return { advertiser, communications };
  });
  if (!data) {
    notFound();
  }

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: "1.5rem", maxWidth: "44rem" }}>
      <Link href="/admin/system/advertisers" style={backLinkStyle}>
        ← 広告主一覧
      </Link>
      <h1 style={titleStyle}>{data.advertiser.companyName} のコミュニケーション履歴</h1>

      {data.communications.length === 0 ? (
        <p style={{ color: "#6b7280", fontSize: "0.9rem" }}>
          コミュニケーション履歴はまだ登録されていません。
        </p>
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>チャネル</th>
              <th style={thStyle}>発生日時</th>
              <th style={thStyle}>件名</th>
              <th style={thStyle}>記録日時</th>
            </tr>
          </thead>
          <tbody>
            {data.communications.map((c) => (
              <tr key={c.id}>
                <td style={tdStyle}>{COMMUNICATION_CHANNEL_LABEL[c.channel]}</td>
                <td style={tdStyle}>{formatJstDateTime(c.occurredAt)}</td>
                <td style={tdStyle}>{c.subject}</td>
                <td style={tdStyle}>{formatJstDateTime(c.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        <h2 style={subTitleStyle}>コミュニケーションの記録</h2>
        <CommunicationCreateForm advertiserId={id} />
      </div>
    </section>
  );
}

const backLinkStyle: React.CSSProperties = {
  fontSize: "0.85rem",
  color: "#2563eb",
  textDecoration: "none",
};
const titleStyle: React.CSSProperties = { fontSize: "1.3rem", fontWeight: 700, margin: 0 };
const subTitleStyle: React.CSSProperties = { fontSize: "1.05rem", fontWeight: 600, margin: 0 };
const tableStyle: React.CSSProperties = {
  borderCollapse: "collapse",
  width: "100%",
  fontSize: "0.9rem",
};
const thStyle: React.CSSProperties = {
  textAlign: "left",
  borderBottom: "2px solid #e5e7eb",
  padding: "0.5rem 0.6rem",
  color: "#374151",
};
const tdStyle: React.CSSProperties = {
  borderBottom: "1px solid #f3f4f6",
  padding: "0.5rem 0.6rem",
  color: "#111827",
};
