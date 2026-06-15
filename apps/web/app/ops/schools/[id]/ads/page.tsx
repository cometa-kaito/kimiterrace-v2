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
 * F10 / #46: **system_admin（運営）の広告掲載導線** (`/ops/schools/{id}/ads`)。**Server Component**。
 *
 * 運営が広告（広告主の素材）を表示する**クラスを選ぶ**ための一覧。各クラスの「広告管理」へ導き、
 * そこで入稿（メディアURL）/ タップリンク / 表示秒数 を設定する（クラス別広告管理ページは ADS_ROLES =
 * school_admin / system_admin で system_admin も操作可。これまで運営側に到達導線が無かったのを補う）。
 *
 * **認可**: `requireRole(SYSTEM_ADMIN_ROLES)`。**可視範囲は RLS（system_admin=全校）**、不可視/不存在/不正 id
 * は 404。クラス一覧は `listSchoolClassesForAdPlacement`（対象校で絞る、テナント境界は RLS）。
 */
export default async function SchoolAdPlacementPage({
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
        <h1 style={titleStyle}>{data.schoolName} の広告掲載</h1>
        <p style={subtitleStyle}>
          広告を表示するクラスを選び、「広告管理」で素材（メディアURL）・タップ時のリンク・表示秒数を
          設定します。学校 / 学科 / 学年への一括掲載は今後対応します（現状はクラス単位）。
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
            // 学科制(department)では「電子工学科 1年」を主表記にし、組(className=A組)は出さない (BUG-3)。
            // 学科制では各「学科 × 学年」に組は 1 つだけで識別子にならないため。クラス制は従来どおり組が主。
            const isDepartmentMode = data.hierarchyMode === "department";
            const primaryLabel = isDepartmentMode
              ? [c.departmentName, c.gradeName].filter(Boolean).join(" ") || c.className
              : c.className;
            // 学科制は主表記に学科×学年が入るため副表記は不要。クラス制は学年を副表記にする。
            const metaLabel = isDepartmentMode ? "" : c.gradeName;
            return (
              <li key={c.classId} style={itemStyle}>
                <span>
                  <strong>{primaryLabel}</strong>
                  {metaLabel ? <span style={metaStyle}>{metaLabel}</span> : null}
                </span>
                <Link href={`/app/editor/${c.classId}/ads`} style={manageLinkStyle}>
                  広告管理 →
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
