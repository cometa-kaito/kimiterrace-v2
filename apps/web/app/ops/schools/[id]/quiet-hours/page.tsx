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
 * **system_admin（運営）の静粛時間 設定導線** (`/ops/schools/{id}/quiet-hours`)。**Server Component**。
 * 広告掲載導線 (`/ops/schools/{id}/ads`、#46/#1002) と対称で、運営が静粛時間を設定する**クラスを選ぶ**
 * ための一覧。各クラスの「静粛時間」へ導き、そこでサイネージを静音 / 非表示にする時間帯を設定する
 * (クラス別静粛時間ページは QUIET_HOURS_ROLES = school_admin / system_admin で system_admin も操作可)。
 *
 * **認可**: `requireRole(SYSTEM_ADMIN_ROLES)`。**可視範囲は RLS（system_admin=全校）**、不可視/不存在/不正 id
 * は 404。クラス一覧は `listSchoolClassesForAdPlacement`（汎用のクラス列挙、対象校で絞る・境界は RLS）。
 */
export default async function SchoolQuietHoursPickerPage({
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
        <h1 style={titleStyle}>{data.schoolName} の静粛時間</h1>
        <p style={subtitleStyle}>
          サイネージを静音 / 非表示にする時間帯を設定するクラスを選びます。学校 / 学科 /
          学年への一括設定は 今後対応します（現状はクラス単位）。
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
            // 学科制(department)では「電子工学科 1年」を主表記にし、組(className=A組)は出さない (ads picker と同方針)。
            // 学科制では各「学科 × 学年」に組は 1 つだけで識別子にならないため。クラス制は従来どおり組が主。
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
                <Link href={`/ops/schools/${id}/quiet-hours/${c.classId}`} style={manageLinkStyle}>
                  静粛時間 →
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
