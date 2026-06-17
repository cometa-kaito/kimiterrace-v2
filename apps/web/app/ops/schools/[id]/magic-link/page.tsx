import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { listSchoolClassesForAdPlacement } from "@/lib/system-admin/ad-placement-queries";
import { SYSTEM_ADMIN_ROLES } from "@/lib/system-admin/roles";
import { isUuid } from "@/lib/system-admin/schools-core";
import { getSchoolDetail } from "@kimiterrace/db";
import { EmptyState } from "@kimiterrace/ui";
import Link from "next/link";
import { notFound } from "next/navigation";

/**
 * F05: **system_admin（運営）の生徒アクセスリンク（magic link）導線** (`/ops/schools/{id}/magic-link`)。
 * **Server Component**。`/ops/schools/{id}` の「生徒アクセスリンク」からの遷移先。
 *
 * 運営がリンクを発行・失効する**クラスを選ぶ**ための一覧。各クラスの「リンク管理」へ導く。発行 API
 * (`POST /api/magic-links`) は MAGIC_LINK_ISSUER_ROLES（school_admin / system_admin）で system_admin も
 * 操作可（対象クラスから学校を cross-tenant 解決し `system_admin_full_access` 下で発行・監査 actor は null）。
 * これまで運営側に到達導線が無かったのを補う（広告掲載 #46 と同型の class picker）。
 *
 * **認可**: `requireRole(SYSTEM_ADMIN_ROLES)`。**可視範囲は RLS（system_admin=全校）**、不可視/不存在/不正 id
 * は 404。クラス一覧は `listSchoolClassesForAdPlacement`（対象校で絞る、テナント境界は RLS）。
 */
export default async function SchoolMagicLinkPlacementPage({
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
    const detail = await getSchoolDetail(tx, id);
    if (!detail) {
      return null;
    }
    const classList = await listSchoolClassesForAdPlacement(tx, id);
    return {
      schoolName: detail.school.name,
      hierarchyMode: detail.school.hierarchyMode,
      classList,
    };
  });
  if (!data) {
    notFound();
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <Link href={`/ops/schools/${id}`} style={backLinkStyle}>
        ← {data.schoolName}
      </Link>
      <header>
        <h1 style={titleStyle}>{data.schoolName} の生徒アクセスリンク</h1>
        <p style={subtitleStyle}>
          リンクを発行するクラスを選び、「リンク管理」で生徒 / サイネージ用の magic link
          を発行・失効します。発行時に表示される URL はその場限りです（後から再表示できません）。
        </p>
      </header>

      {data.classList.length === 0 ? (
        <EmptyState
          title="クラスがありません"
          description={
            <>
              先に
              <Link href={`/ops/schools/${id}`} style={{ color: "#1d4ed8" }}>
                {" "}
                学校の階層{" "}
              </Link>
              にクラスを登録してください。
            </>
          }
        />
      ) : (
        <ul style={listStyle}>
          {data.classList.map((c) => {
            // 学科制(department)では「電子工学科 1年」を主表記にし、組(className=A組)は出さない (広告掲載と同方針)。
            const isDepartmentMode = data.hierarchyMode === "department";
            const primaryLabel = isDepartmentMode
              ? [c.departmentName, c.gradeName].filter(Boolean).join(" ") || c.className
              : c.className;
            const metaLabel = isDepartmentMode ? "" : c.gradeName;
            return (
              <li key={c.classId} style={itemStyle}>
                <span>
                  <strong>{primaryLabel}</strong>
                  {metaLabel ? <span style={metaStyle}>{metaLabel}</span> : null}
                </span>
                <Link href={`/ops/schools/${id}/magic-link/${c.classId}`} style={manageLinkStyle}>
                  リンク管理 →
                </Link>
              </li>
            );
          })}
        </ul>
      )}
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
  color: "#9ca3af",
  fontSize: "0.8rem",
  marginLeft: "0.6rem",
};
const manageLinkStyle: React.CSSProperties = {
  fontSize: "0.9rem",
  color: "#1d4ed8",
  whiteSpace: "nowrap",
};
