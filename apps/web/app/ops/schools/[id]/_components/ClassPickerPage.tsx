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
 * **system_admin（運営）のクラス選択 picker** 共通コンポーネント（Server Component）。
 *
 * `/ops/schools/{id}/{ads,quiet-hours,magic-link,editor}` の 4 導線で同一だった
 * 「対象校のクラス一覧を出し、各クラスの機能ページへ導く」骨格を 1 箇所に集約したもの
 * (A〜D プログラム #1002/#1003/#1004/#1009/#1011 で ads をテンプレに複製した結果の DRY 解消、
 * #1009 Reviewer の Minor 指摘)。**挙動・見た目・認可は 4 ページで完全に同一**で、機能ごとに
 * 異なるのは 見出しの語 / サブ説明 / 行アクションのラベル / クラスの遷移先パス のみ。これらを
 * props 化する。
 *
 * **認可**: `requireRole(SYSTEM_ADMIN_ROLES)`。**可視範囲は RLS（system_admin=全校）**、
 * 不可視/不存在/不正 id は 404。クラス一覧は `listSchoolClassesForAdPlacement`（対象校で絞る、
 * テナント境界は RLS）。
 */
export type ClassPickerPageProps = {
  /** 対象校 ID（route param `id` の生値）。UUID 検証は本コンポーネントが行い、不正なら 404。 */
  schoolId: string;
  /** 見出しの語。`{校名} の{title}` として描画する（例: "広告掲載"）。 */
  title: string;
  /** 見出し下のサブ説明文。 */
  subtitle: React.ReactNode;
  /** 各クラス行のアクションリンクのラベル（例: "広告管理 →"）。 */
  classLinkLabel: string;
  /** クラス ID → 遷移先パス（例: `(classId) => \`/ops/schools/${id}/ads/${classId}\``）。 */
  classHref: (classId: string) => string;
};

export async function ClassPickerPage({
  schoolId,
  title,
  subtitle,
  classLinkLabel,
  classHref,
}: ClassPickerPageProps) {
  await requireRole(SYSTEM_ADMIN_ROLES);
  if (!isUuid(schoolId)) {
    notFound();
  }

  const data = await withSession(async (tx) => {
    const detail = await getSchoolDetail(tx, schoolId);
    if (!detail) {
      return null;
    }
    const classList = await listSchoolClassesForAdPlacement(tx, schoolId);
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
      <Link href={`/ops/schools/${schoolId}`} style={backLinkStyle}>
        ← {data.schoolName}
      </Link>
      <header>
        <h1 style={titleStyle}>
          {data.schoolName} の{title}
        </h1>
        <p style={subtitleStyle}>{subtitle}</p>
      </header>

      {data.classList.length === 0 ? (
        <EmptyState
          title="クラスがありません"
          description={
            <>
              先に
              <Link href={`/ops/schools/${schoolId}`} style={{ color: "#1d4ed8" }}>
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
                <Link href={classHref(c.classId)} style={manageLinkStyle}>
                  {classLinkLabel}
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
