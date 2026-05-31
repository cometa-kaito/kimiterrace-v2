import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { listAdvertisers } from "@/lib/system-admin/advertisers-queries";
import { SYSTEM_ADMIN_ROLES } from "@/lib/system-admin/roles";
import Link from "next/link";
import { AdvertiserActiveToggle } from "./_components/AdvertiserActiveToggle";

/**
 * F10 (#46): システム管理者の広告主一覧 (`/admin/system/advertisers`)。**Server Component**。
 *
 * **認可**: `/admin` レイアウトの `requireRole(ADMIN_ROLES)` に加え `requireRole(SYSTEM_ADMIN_ROLES)`
 * (system_admin のみ)。広告主マスタ (CRM) は cross-tenant の横断データで system_admin 専用、
 * school_admin / teacher は 403 (`/forbidden`)。`withSession` の RLS context 下で `listAdvertisers` を
 * 呼ぶ — 可視範囲は advertisers の RLS (`system_admin_full_access`) が決める。
 *
 * 本スライス (#46 第1弾) は**一覧の閲覧のみ**。新規登録 / 詳細 / 編集 (契約・コミュニケーション含む)
 * は follow-up に切り出す。サイドナビ (`lib/nav.ts`) への導線追加は、同ファイルを編集中の F08 (#264)
 * と衝突するため #264 land 後の follow-up とする (本ページは URL 直アクセスで到達可)。
 */
export default async function SystemAdvertisersPage() {
  await requireRole(SYSTEM_ADMIN_ROLES);
  const advertisers = await withSession((tx) => listAdvertisers(tx));
  const activeCount = advertisers.filter((a) => a.isActive).length;

  return (
    <section>
      <header style={headerStyle}>
        <h1 style={titleStyle}>広告主一覧</h1>
        <div style={headerRightStyle}>
          <span style={countStyle}>
            稼働 {activeCount} / 全 {advertisers.length} 社
          </span>
          <Link href="/admin/system/advertisers/new" style={newLinkStyle}>
            ＋ 新規登録
          </Link>
        </div>
      </header>

      {advertisers.length === 0 ? (
        <p style={emptyStyle}>登録されている広告主がありません。</p>
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>会社名</th>
              <th style={thStyle}>業種</th>
              <th style={thStyle}>担当連絡先</th>
              <th style={thStyle}>状態</th>
              <th style={thStyle}>登録日</th>
              <th style={thStyle}>操作</th>
            </tr>
          </thead>
          <tbody>
            {advertisers.map((a) => (
              <tr key={a.id}>
                <td style={{ ...tdStyle, fontWeight: 600 }}>{a.companyName}</td>
                <td style={tdStyle}>{a.industry ?? "—"}</td>
                <td style={tdStyle}>{a.contactEmail ?? "—"}</td>
                <td style={tdStyle}>
                  <span style={statusCellStyle}>
                    <StatusBadge isActive={a.isActive} />
                    <AdvertiserActiveToggle
                      advertiserId={a.id}
                      isActive={a.isActive}
                      companyName={a.companyName}
                    />
                  </span>
                </td>
                <td style={tdStyle}>{formatJstDate(a.createdAt)}</td>
                <td style={tdStyle}>
                  <Link href={`/admin/system/advertisers/${a.id}/edit`} style={editLinkStyle}>
                    編集
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** 稼働中 / 停止 (論理削除) のステータスバッジ。 */
function StatusBadge({ isActive }: { isActive: boolean }) {
  return (
    <span style={isActive ? activeBadgeStyle : inactiveBadgeStyle}>
      {isActive ? "稼働中" : "停止"}
    </span>
  );
}

/** createdAt を JST の YYYY/MM/DD で表示する (サーバー描画、ロケール非依存に固定)。 */
function formatJstDate(value: Date): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  marginBottom: "1rem",
};
const titleStyle: React.CSSProperties = { fontSize: "1.3rem", fontWeight: 700 };
const headerRightStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "1rem",
};
const countStyle: React.CSSProperties = { fontSize: "0.85rem", color: "#6b7280" };
const newLinkStyle: React.CSSProperties = {
  fontSize: "0.85rem",
  color: "#fff",
  background: "#1d4ed8",
  padding: "0.4rem 0.9rem",
  borderRadius: "6px",
  textDecoration: "none",
};
const emptyStyle: React.CSSProperties = { color: "#6b7280" };
const editLinkStyle: React.CSSProperties = {
  fontSize: "0.85rem",
  color: "#2563eb",
  textDecoration: "none",
};
const tableStyle: React.CSSProperties = { borderCollapse: "collapse", width: "100%" };
const thStyle: React.CSSProperties = {
  textAlign: "left",
  fontSize: "0.85rem",
  color: "#6b7280",
  padding: "0.4rem 0.6rem",
  borderBottom: "1px solid #e5e7eb",
};
const tdStyle: React.CSSProperties = {
  padding: "0.5rem 0.6rem",
  borderBottom: "1px solid #f3f4f6",
  fontSize: "0.9rem",
};
const statusCellStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.6rem",
};
const activeBadgeStyle: React.CSSProperties = {
  fontSize: "0.75rem",
  padding: "0.1rem 0.5rem",
  borderRadius: "999px",
  background: "#dcfce7",
  color: "#166534",
};
const inactiveBadgeStyle: React.CSSProperties = {
  fontSize: "0.75rem",
  padding: "0.1rem 0.5rem",
  borderRadius: "999px",
  background: "#f3f4f6",
  color: "#6b7280",
};
