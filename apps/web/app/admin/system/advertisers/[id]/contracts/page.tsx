import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { getAdvertiserDetail } from "@/lib/system-admin/advertisers-queries";
import { CONTRACT_STATUS_LABEL } from "@/lib/system-admin/contracts-core";
import { listContractsByAdvertiser } from "@/lib/system-admin/contracts-queries";
import { SYSTEM_ADMIN_ROLES } from "@/lib/system-admin/roles";
import { isUuid } from "@/lib/system-admin/schools-core";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ContractCreateForm } from "./_components/ContractCreateForm";
import { ContractStatusControl } from "./_components/ContractStatusControl";

/**
 * F10 (#46): ある広告主の契約一覧 + 新規登録 (`/admin/system/advertisers/{id}/contracts`)。
 * **Server Component**。
 *
 * **認可**: `requireRole(SYSTEM_ADMIN_ROLES)` (system_admin のみ、契約は cross-tenant)。`withSession` の
 * RLS tx で広告主詳細 (見出し用) + 契約一覧を取得 — 可視範囲は RLS が決め、不可視 / 不存在 / 不正 id は
 * 404。作成・検証・監査・状態遷移・編集は各 Server Action が担う (本画面は表示 + 作成フォーム + 遷移ボタン)。
 */

/** Date | null を YYYY-MM-DD へ (null は "—")。drizzle mode:date で Date が来る。 */
function formatDate(d: Date | null): string {
  return d ? d.toISOString().slice(0, 10) : "—";
}

export default async function AdvertiserContractsPage({
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
    const contracts = await listContractsByAdvertiser(tx, id);
    return { advertiser, contracts };
  });
  if (!data) {
    notFound();
  }

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: "1.5rem", maxWidth: "44rem" }}>
      <Link href="/admin/system/advertisers" style={backLinkStyle}>
        ← 広告主一覧
      </Link>
      <h1 style={titleStyle}>{data.advertiser.companyName} の契約</h1>

      {data.contracts.length === 0 ? (
        <p style={{ color: "#6b7280", fontSize: "0.9rem" }}>契約はまだ登録されていません。</p>
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>ステータス</th>
              <th style={thStyle}>開始日</th>
              <th style={thStyle}>終了日</th>
              <th style={{ ...thStyle, textAlign: "right" }}>月額（税抜）</th>
              <th style={thStyle}>状態変更</th>
            </tr>
          </thead>
          <tbody>
            {data.contracts.map((c) => (
              <tr key={c.id}>
                <td style={tdStyle}>{CONTRACT_STATUS_LABEL[c.status]}</td>
                <td style={tdStyle}>{formatDate(c.startedAt)}</td>
                <td style={tdStyle}>{formatDate(c.endedAt)}</td>
                <td style={{ ...tdStyle, textAlign: "right" }}>
                  ¥{c.monthlyFeeJpy.toLocaleString("ja-JP")}
                </td>
                <td style={tdStyle}>
                  <ContractStatusControl contractId={c.id} status={c.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        <h2 style={subTitleStyle}>新規契約の登録</h2>
        <ContractCreateForm advertiserId={id} />
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
