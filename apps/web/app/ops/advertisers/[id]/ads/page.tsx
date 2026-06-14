import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { getAdvertiserDetail } from "@/lib/system-admin/advertisers-queries";
import { listAdvertiserAds } from "@/lib/system-admin/operator-ads-queries";
import { SYSTEM_ADMIN_ROLES } from "@/lib/system-admin/roles";
import { isUuid } from "@/lib/system-admin/schools-core";
import { listSchools } from "@kimiterrace/db";
import { EmptyState } from "@kimiterrace/ui";
import Link from "next/link";
import { notFound } from "next/navigation";
import { OperatorAdDeleteButton } from "./_components/OperatorAdDeleteButton";
import { OperatorAdForm } from "./_components/OperatorAdForm";

/**
 * F10 / #46: **運営側広告 CRM** — 広告主配下の広告管理 (`/ops/advertisers/{id}/ads`)。
 * **Server Component**。運営 (system_admin) が広告主のために入稿した広告（scope='school'）を一覧し、
 * 新規入稿フォーム + 削除を提供する。
 *
 * **認可**: `requireRole(SYSTEM_ADMIN_ROLES)`。可視範囲は RLS（system_admin=全校/全広告主）。不正 id /
 * 不存在は 404。学校の自校クラス広告（advertiser_id null）は本一覧に出ない（広告主紐付け広告のみ）。
 */
const MEDIA_TYPE_LABEL: Record<string, string> = { image: "画像", video: "動画" };

export default async function AdvertiserAdsPage({ params }: { params: Promise<{ id: string }> }) {
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
    const adList = await listAdvertiserAds(tx, id);
    const schools = await listSchools(tx);
    return { advertiser, adList, schools };
  });
  if (!data) {
    notFound();
  }

  const schoolOptions = data.schools.map((s) => ({
    id: s.id,
    name: s.name,
    prefecture: s.prefecture,
  }));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
      <Link href="/ops/advertisers" style={backLinkStyle}>
        ← 広告主一覧
      </Link>
      <header>
        <h1 style={titleStyle}>{data.advertiser.companyName} の広告</h1>
        <p style={subtitleStyle}>
          この広告主の広告を入稿・管理します。選んだ学校の全クラスのサイネージに表示されます
          （学年/学科/クラス単位の絞り込みは今後対応）。
        </p>
      </header>

      <section>
        <h2 style={sectionHeadingStyle}>入稿済みの広告</h2>
        {data.adList.length === 0 ? (
          <EmptyState
            title="まだ広告がありません"
            description="下のフォームから最初の広告を入稿してください。"
          />
        ) : (
          <ul style={listStyle}>
            {data.adList.map((ad) => (
              <li key={ad.adId} style={itemStyle}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <strong>{ad.schoolName}</strong>
                  <span style={metaStyle}>
                    {MEDIA_TYPE_LABEL[ad.mediaType] ?? ad.mediaType} / {ad.durationSec}秒
                    {ad.linkUrl ? " / リンクあり" : ""}
                    {ad.caption ? ` / 「${ad.caption}」` : ""}
                  </span>
                  <a href={ad.mediaUrl} target="_blank" rel="noreferrer" style={mediaLinkStyle}>
                    素材を開く
                  </a>
                </span>
                <OperatorAdDeleteButton adId={ad.adId} label={`${ad.schoolName} の広告`} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section style={formCardStyle}>
        <OperatorAdForm advertiserId={id} schools={schoolOptions} />
      </section>
    </div>
  );
}

const backLinkStyle: React.CSSProperties = { fontSize: "0.85rem", color: "#2563eb" };
const titleStyle: React.CSSProperties = {
  fontSize: "1.4rem",
  fontWeight: 700,
  margin: "0 0 0.25rem",
};
const subtitleStyle: React.CSSProperties = { color: "#6b7280", fontSize: "0.9rem", margin: 0 };
const sectionHeadingStyle: React.CSSProperties = {
  fontSize: "1rem",
  fontWeight: 700,
  margin: "0 0 0.6rem",
};
const listStyle: React.CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: "0.5rem",
};
const itemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "1rem",
  padding: "0.6rem 0.9rem",
  border: "1px solid #e5e7eb",
  borderRadius: "8px",
  background: "#fff",
};
const metaStyle: React.CSSProperties = {
  color: "#6b7280",
  fontSize: "0.82rem",
  marginLeft: "0.6rem",
};
const mediaLinkStyle: React.CSSProperties = {
  marginLeft: "0.6rem",
  fontSize: "0.82rem",
  color: "#1d4ed8",
};
const formCardStyle: React.CSSProperties = {
  border: "1px solid #e5e7eb",
  borderRadius: "10px",
  padding: "1rem",
  background: "#fafafa",
};
