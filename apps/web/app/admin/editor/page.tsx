import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { EDITOR_ROLES } from "@/lib/editor/schedule-core";
import { getSchoolHierarchy } from "@/lib/school-admin/hub-queries";
import type { GradeView } from "@/lib/school-admin/hub-queries";
import Link from "next/link";

/**
 * エディタ着地 (#48-H)。編集対象を **階層ツリー（学科 → 学年 → クラス）** で選ぶ（旧フラット一覧を
 * 置換、ユーザー報告 2026-06-06「クラスを選択 UI が分かりにくい」への対応）。クラスをクリックすると
 * `/admin/editor/[classId]` の編集へ。`getSchoolHierarchy`（RLS tx・自校）で学科/学年/クラスを取得。
 *
 * **空状態はロール別 (校務DX原則)**: クラス 0 件のとき、school_admin には学校管理への導線を、teacher には
 * 「管理者が追加すると表示される」案内に留める（teacher は /admin/school で 403 になるため死リンクを出さない）。
 *
 * 注: 「学校全体 / 学科全体 / 学年全体」のまとめ編集（scope 対応）は後続スライスで本ツリーに追加する。
 */
export default async function EditorIndexPage() {
  const user = await requireRole(EDITOR_ROLES);
  const hierarchy = await withSession((tx) => getSchoolHierarchy(tx));
  const { departments, grades } = hierarchy;
  const gradesOf = (deptId: string | null) => grades.filter((g) => g.departmentId === deptId);
  const orphanGrades = grades.filter((g) => !g.departmentId);
  const totalClasses = grades.reduce((n, g) => n + g.classes.length, 0);

  return (
    <div style={{ maxWidth: "720px" }}>
      <h1 style={{ fontSize: "1.4rem", marginBottom: "1rem" }}>エディタ — 編集する対象を選ぶ</h1>

      {totalClasses === 0 ? (
        user.role === "school_admin" ? (
          <p style={mutedStyle}>
            編集できるクラスがまだありません。<Link href="/admin/school">学校管理</Link>
            で学科・学年・クラスを追加してください。
          </p>
        ) : (
          <p style={mutedStyle}>
            まだクラスがありません。学校管理者がクラスを追加すると、ここに表示されます。
          </p>
        )
      ) : (
        <div style={{ display: "grid", gap: "1rem" }}>
          {departments.length > 0 ? (
            <>
              {departments.map((d) => (
                <section key={d.id} style={deptCardStyle}>
                  <h2 style={deptTitleStyle}>{d.name}</h2>
                  <GradeGroups grades={gradesOf(d.id)} />
                </section>
              ))}
              {orphanGrades.length > 0 ? (
                <section style={deptCardStyle}>
                  <h2 style={deptTitleStyle}>学科未割当</h2>
                  <GradeGroups grades={orphanGrades} />
                </section>
              ) : null}
            </>
          ) : (
            <section style={deptCardStyle}>
              <GradeGroups grades={grades} />
            </section>
          )}
        </div>
      )}
    </div>
  );
}

/** 学年ごとに見出し + 配下クラスのリンクを出す。 */
function GradeGroups({ grades }: { grades: GradeView[] }) {
  if (grades.length === 0) {
    return <p style={mutedSmallStyle}>学年がありません。</p>;
  }
  return (
    <div style={{ display: "grid", gap: "0.6rem" }}>
      {grades.map((g) => (
        <div key={g.id}>
          <h3 style={gradeTitleStyle}>{g.name}</h3>
          {g.classes.length === 0 ? (
            <p style={mutedSmallStyle}>クラスがありません（学校管理で追加）。</p>
          ) : (
            <ul style={classListStyle}>
              {g.classes.map((c) => (
                <li key={c.id}>
                  <Link href={`/admin/editor/${c.id}`} style={classLinkStyle}>
                    {c.name}
                    <span style={classMetaStyle}>{c.academicYear}年度</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}

const mutedStyle: React.CSSProperties = { color: "#6b7280" };
const mutedSmallStyle: React.CSSProperties = { color: "#9ca3af", fontSize: "0.85rem", margin: 0 };
const deptCardStyle: React.CSSProperties = {
  border: "1px solid #e5e7eb",
  borderRadius: "10px",
  padding: "1rem",
};
const deptTitleStyle: React.CSSProperties = { fontSize: "1.1rem", margin: "0 0 0.6rem" };
const gradeTitleStyle: React.CSSProperties = {
  fontSize: "0.95rem",
  color: "#374151",
  margin: "0 0 0.35rem",
};
const classListStyle: React.CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexWrap: "wrap",
  gap: "0.5rem",
};
const classLinkStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.5rem",
  padding: "0.5rem 0.9rem",
  border: "1px solid #e5e7eb",
  borderRadius: "8px",
  textDecoration: "none",
  color: "#1f2937",
  background: "#fff",
};
const classMetaStyle: React.CSSProperties = { color: "#9ca3af", fontSize: "0.78rem" };
