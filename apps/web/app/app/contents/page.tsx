import { requireRole } from "@/lib/auth/guard";
import { PUBLISHER_ROLES, type PublishScopeValue } from "@/lib/contents/publish-core";
import { scopeLabel } from "@/lib/contents/publish-view";
import { withSession } from "@/lib/db";
import { listContents } from "@kimiterrace/db";
import { tokens } from "@kimiterrace/ui";
import Link from "next/link";
import { ContentStatusBadge } from "./_components/ContentStatusBadge";

/**
 * F04: コンテンツ一覧 (`/app/contents`)。**Server Component**。
 *
 * **認可 (#166)**: `/admin` レイアウトの `requireRole(ADMIN_ROLES)` に加え、本ページは
 * `requireRole(PUBLISHER_ROLES)` (school_admin / teacher) に限定する。F04 は「自校の公開フロー」が
 * 対象で、system_admin は `system_admin_full_access` policy (0002, ADR-019) により**全校横断で
 * 全件可視**になるため、学校識別の無いこの自校用一覧に混ぜると区別不能になる (UX 破綻)。
 * mutation 自体は `toActor`→null→forbidden で既に封じ済 (セキュリティ違反ではない) だが、
 * 横断データを自校用画面に晒さない方針で system_admin は早期 403 (`/forbidden`) に倒す。
 * 横断コンテンツ管理が要れば system_admin 専用画面を別途用意する (本 Issue の方針 A)。
 *
 * `withSession` で RLS context を張って自校のコンテンツを取得する (`listContents`、PR #156)。
 * 行をクリックすると詳細 (公開操作 / バージョンタイムライン) へ。
 */
export default async function ContentsListPage() {
  await requireRole(PUBLISHER_ROLES);
  const items = await withSession((tx) => listContents(tx));

  return (
    <section>
      <h1 style={titleStyle}>コンテンツ</h1>
      {items.length === 0 ? (
        // エディタの空状態と同様、行き止まりにせず作成導線を示す（PUBLISHER_ROLES はどちらも到達可）。
        <p style={emptyStyle}>
          まだコンテンツがありません。
          <Link href="/app/teacher-input" style={emptyLinkStyle}>
            音声 / チャット入力
          </Link>
          やエディタから作成できます。
        </p>
      ) : (
        <ul style={listStyle}>
          {items.map((item) => (
            <li key={item.id} style={rowStyle}>
              <Link href={`/app/contents/${item.id}`} style={linkStyle}>
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
const emptyStyle: React.CSSProperties = { color: tokens.color.muted };
const emptyLinkStyle: React.CSSProperties = {
  color: tokens.color.blueStrong,
  textDecoration: "underline",
};
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
