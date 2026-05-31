import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { SYSTEM_ADMIN_ROLES } from "@/lib/system-admin/roles";
import { listSchools } from "@kimiterrace/db";
import type { SchoolHierarchyMode } from "@kimiterrace/db/schema";
import Link from "next/link";

/** 階層モードの表示ラベル (一覧の列)。enum 値を網羅 (型でズレ検出、ルール3)。 */
const HIERARCHY_MODE_LABEL: Record<SchoolHierarchyMode, string> = {
  class: "クラス制",
  department: "学科制",
};

/**
 * #48-L (#123): システム管理者の学校一覧 (`/admin/system/schools`)。**Server Component**。
 *
 * **認可**: `/admin` レイアウトの `requireRole(ADMIN_ROLES)` に加え、本ページは
 * `requireRole(SYSTEM_ADMIN_ROLES)` (system_admin のみ) に限定する。横断 (全校) マスタの閲覧は
 * system_admin 専用で、school_admin / teacher は 403 (`/forbidden`)。
 *
 * `withSession` で RLS context を張り `listSchools` を呼ぶ。可視範囲は schools の RLS が決め
 * (system_admin=全校 / それ以外=自校のみ)、本ページは system_admin 専用なので全校が並ぶ。
 * 各行は校名から詳細 (`/admin/system/schools/{id}`、#48-L2) / 「編集」から編集
 * (`/admin/system/schools/{id}/edit`、#48-L1) に遷移できる。create/delete は follow-up。
 */
export default async function SystemSchoolsPage() {
  await requireRole(SYSTEM_ADMIN_ROLES);
  const schools = await withSession((tx) => listSchools(tx));

  return (
    <section>
      <header style={headerStyle}>
        <h1 style={titleStyle}>学校一覧</h1>
        <span style={countStyle}>{schools.length} 校</span>
      </header>

      {schools.length === 0 ? (
        <p style={emptyStyle}>登録されている学校がありません。</p>
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>都道府県</th>
              <th style={thStyle}>学校名</th>
              <th style={thStyle}>学校コード</th>
              <th style={thStyle}>階層モード</th>
              <th style={thStyle}>登録日</th>
              <th style={thStyle} />
            </tr>
          </thead>
          <tbody>
            {schools.map((s) => (
              <tr key={s.id}>
                <td style={tdStyle}>{s.prefecture}</td>
                <td style={{ ...tdStyle, fontWeight: 600 }}>
                  <Link href={`/admin/system/schools/${s.id}`} style={nameLinkStyle}>
                    {s.name}
                  </Link>
                </td>
                <td style={tdStyle}>{s.code ?? "—"}</td>
                <td style={tdStyle}>{HIERARCHY_MODE_LABEL[s.hierarchyMode]}</td>
                <td style={tdStyle}>{formatJstDate(s.createdAt)}</td>
                <td style={tdStyle}>
                  <a href={`/admin/system/schools/${s.id}/edit`} style={editLinkStyle}>
                    編集
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
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
const countStyle: React.CSSProperties = { fontSize: "0.85rem", color: "#6b7280" };
const emptyStyle: React.CSSProperties = { color: "#6b7280" };
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
const editLinkStyle: React.CSSProperties = { color: "#1d4ed8", fontSize: "0.85rem" };
const nameLinkStyle: React.CSSProperties = { color: "#1f2937", textDecoration: "none" };
