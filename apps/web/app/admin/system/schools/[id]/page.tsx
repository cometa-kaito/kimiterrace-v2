import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { SYSTEM_ADMIN_ROLES } from "@/lib/system-admin/roles";
import { isUuid } from "@/lib/system-admin/schools-core";
import { getSchoolDetail } from "@kimiterrace/db";
import type { SchoolHierarchyMode } from "@kimiterrace/db/schema";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SchoolDeleteButton } from "./_components/SchoolDeleteButton";

/** 階層モードの表示ラベル。enum 値を網羅 (型でズレ検出、ルール3、一覧ページと同方針)。 */
const HIERARCHY_MODE_LABEL: Record<SchoolHierarchyMode, string> = {
  class: "クラス制",
  department: "学科制",
};

/**
 * #48-L2 (#123): システム管理者の学校詳細 (`/admin/system/schools/{id}`)。**Server Component**。
 *
 * **認可**: `/admin` layout の `requireRole(ADMIN_ROLES)` に加え `requireRole(SYSTEM_ADMIN_ROLES)`
 * (system_admin のみ)。school_admin / teacher は 403 (`/forbidden`)。
 *
 * `withSession` の RLS tx で `getSchoolDetail` を取得 — マスタ全フィールド + 配下の学年/クラス/学科の
 * 件数。可視範囲は schools の RLS が決め (system_admin=全校)、不可視 (他校 / 不存在 / 不正 id) は
 * 404 (`notFound()`)。編集は本画面の「編集」リンクから `/{id}/edit` (#48-L1) へ。
 */
export default async function SystemSchoolDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireRole(SYSTEM_ADMIN_ROLES);
  const { id } = await params;
  if (!isUuid(id)) {
    notFound();
  }
  const detail = await withSession((tx) => getSchoolDetail(tx, id));
  if (!detail) {
    notFound();
  }
  const { school, counts } = detail;

  return (
    <article style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
      <Link href="/admin/system/schools" style={backLinkStyle}>
        ← 学校一覧
      </Link>

      <header style={headerStyle}>
        <h1 style={titleStyle}>{school.name}</h1>
        <div style={headerActionsStyle}>
          {/* 広告掲載导线 (#46): 運営がこの学校のクラスを選び、クラス別広告管理で素材/リンク/秒数を設定する。 */}
          <Link href={`/admin/system/schools/${school.id}/ads`} style={editLinkStyle}>
            広告掲載
          </Link>
          <Link href={`/admin/system/schools/${school.id}/edit`} style={editLinkStyle}>
            編集
          </Link>
          <SchoolDeleteButton schoolId={school.id} schoolName={school.name} />
        </div>
      </header>

      <dl style={dlStyle}>
        <Field label="都道府県" value={school.prefecture} />
        <Field label="学校コード" value={school.code ?? "—"} />
        <Field label="階層モード" value={HIERARCHY_MODE_LABEL[school.hierarchyMode]} />
        <Field label="備考" value={school.notes ?? "—"} />
        <Field label="登録日" value={formatJstDateTime(school.createdAt)} />
        <Field label="更新日" value={formatJstDateTime(school.updatedAt)} />
      </dl>

      <section>
        <h2 style={sectionTitleStyle}>階層</h2>
        <div style={countsRowStyle}>
          <CountCard label="学年" value={counts.grades} />
          {school.hierarchyMode === "department" ? (
            <CountCard label="学科" value={counts.departments} />
          ) : null}
          <CountCard label="クラス" value={counts.classes} />
        </div>
      </section>
    </article>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div style={fieldStyle}>
      <dt style={dtStyle}>{label}</dt>
      <dd style={ddStyle}>{value}</dd>
    </div>
  );
}

function CountCard({ label, value }: { label: string; value: number }) {
  return (
    <div style={cardStyle}>
      <div style={cardValueStyle}>{value}</div>
      <div style={cardLabelStyle}>{label}</div>
    </div>
  );
}

/** createdAt/updatedAt を JST の YYYY/MM/DD HH:mm で表示する (サーバー描画、ロケール固定)。 */
function formatJstDateTime(value: Date): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}

const backLinkStyle: React.CSSProperties = {
  fontSize: "0.85rem",
  color: "#2563eb",
  textDecoration: "none",
};
const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: "1rem",
};
const titleStyle: React.CSSProperties = { fontSize: "1.4rem", fontWeight: 700, margin: 0 };
const headerActionsStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: "1rem",
};
const editLinkStyle: React.CSSProperties = { color: "#1d4ed8", fontSize: "0.9rem" };
const dlStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "max-content 1fr",
  gap: "0.5rem 1.5rem",
  margin: 0,
};
const fieldStyle: React.CSSProperties = { display: "contents" };
const dtStyle: React.CSSProperties = { color: "#6b7280", fontSize: "0.85rem" };
const ddStyle: React.CSSProperties = { margin: 0, fontSize: "0.9rem", whiteSpace: "pre-wrap" };
const sectionTitleStyle: React.CSSProperties = {
  fontSize: "1rem",
  fontWeight: 700,
  marginBottom: "0.6rem",
};
const countsRowStyle: React.CSSProperties = { display: "flex", gap: "0.75rem" };
const cardStyle: React.CSSProperties = {
  border: "1px solid #e5e7eb",
  borderRadius: "8px",
  padding: "0.75rem 1.25rem",
  textAlign: "center",
  minWidth: "5rem",
};
const cardValueStyle: React.CSSProperties = { fontSize: "1.5rem", fontWeight: 700 };
const cardLabelStyle: React.CSSProperties = { fontSize: "0.8rem", color: "#6b7280" };
