import type { PublishScopeValue } from "@/lib/contents/publish-core";
import { scopeLabel } from "@/lib/contents/publish-view";
import { withSession } from "@/lib/db";
import { listContents } from "@kimiterrace/db";
import Link from "next/link";
import { ContentStatusBadge } from "./_components/ContentStatusBadge";

/**
 * F04: コンテンツ一覧 (`/admin/contents`)。**Server Component**。
 *
 * `withSession` で RLS context を張って自校のコンテンツを取得する (`listContents`、PR #156)。
 * 認可は `/admin` レイアウトの `requireRole(ADMIN_ROLES)` が担保済 (本体は RLS、ADR-019)。
 * 行をクリックすると詳細 (公開操作 / バージョンタイムライン) へ。
 */
export default async function ContentsListPage() {
  const items = await withSession((tx) => listContents(tx));

  return (
    <section>
      <h1 style={titleStyle}>コンテンツ</h1>
      {items.length === 0 ? (
        <p style={emptyStyle}>まだコンテンツがありません。</p>
      ) : (
        <ul style={listStyle}>
          {items.map((item) => (
            <li key={item.id} style={rowStyle}>
              <Link href={`/admin/contents/${item.id}`} style={linkStyle}>
                <span style={rowTitleStyle}>{item.title}</span>
              </Link>
              <span style={metaStyle}>
                {/* publishScope は DB enum 由来で値域が保証されるため表示用に narrow する。 */}
                <span style={scopeStyle}>{scopeLabel(item.publishScope as PublishScopeValue)}</span>
                <ContentStatusBadge status={item.status} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const titleStyle: React.CSSProperties = {
  fontSize: "1.3rem",
  fontWeight: 700,
  marginBottom: "1rem",
};
const emptyStyle: React.CSSProperties = { color: "#6b7280" };
const listStyle: React.CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: "0.5rem",
};
const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "1rem",
  padding: "0.6rem 0.9rem",
  border: "1px solid #e5e7eb",
  borderRadius: "8px",
};
const linkStyle: React.CSSProperties = {
  textDecoration: "none",
  color: "#1f2937",
  flex: 1,
  minWidth: 0,
};
const rowTitleStyle: React.CSSProperties = { fontWeight: 600 };
const metaStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: "0.6rem" };
const scopeStyle: React.CSSProperties = { fontSize: "0.8rem", color: "#6b7280" };
