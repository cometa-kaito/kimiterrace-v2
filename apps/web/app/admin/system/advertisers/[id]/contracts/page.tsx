import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { getAdvertiserDetail } from "@/lib/system-admin/advertisers-queries";
import { listLinkedContents } from "@/lib/system-admin/contract-contents-queries";
import { CONTRACT_STATUS_LABEL } from "@/lib/system-admin/contracts-core";
import { listContractsByAdvertiser } from "@/lib/system-admin/contracts-queries";
import { SYSTEM_ADMIN_ROLES } from "@/lib/system-admin/roles";
import { isUuid } from "@/lib/system-admin/schools-core";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ContractContentLinks } from "./_components/ContractContentLinks";
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
    // 各契約に紐付いた出稿コンテンツを同一 RLS tx で取得する (system_admin context = cross-tenant 可視)。
    const linksByContract = new Map<string, Awaited<ReturnType<typeof listLinkedContents>>>();
    for (const c of contracts) {
      linksByContract.set(c.id, await listLinkedContents(tx, c.id));
    }
    return { advertiser, contracts, linksByContract };
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

      {data.contracts.length > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
          <h2 style={subTitleStyle}>契約ごとの出稿コンテンツ</h2>
          {data.contracts.map((c) => (
            <div key={c.id} style={contractBlockStyle}>
              <p style={contractCaptionStyle}>
                {CONTRACT_STATUS_LABEL[c.status]}・{formatDate(c.startedAt)}〜
                {formatDate(c.endedAt)}・ ¥{c.monthlyFeeJpy.toLocaleString("ja-JP")}
              </p>
              <ContractContentLinks
                contractId={c.id}
                advertiserId={id}
                links={(data.linksByContract.get(c.id) ?? []).map((l) => ({
                  linkId: l.linkId,
                  contentId: l.contentId,
                  title: l.title,
                  schoolId: l.schoolId,
                }))}
              />
            </div>
          ))}
        </div>
      ) : null}

      <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        <h2 style={subTitleStyle}>新規契約の登録</h2>
        <ContractCreateForm advertiserId={id} />
      </div>
    </section>
  );
}

const contractBlockStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.4rem",
};
const contractCaptionStyle: React.CSSProperties = {
  margin: 0,
  fontSize: "0.82rem",
  color: "#6b7280",
};

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
