import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { EDITOR_ROLES } from "@/lib/editor/schedule-core";
import { getSchoolClasses } from "@/lib/editor/schedule-queries";
import Link from "next/link";

/**
 * エディタ着地 (#48-H)。編集対象クラスを選ぶ。`/admin/editor/[classId]` で時間割編集へ。
 * Notice / Assignment セクション (#48-I) も同じクラス別エディタに後続で追加される想定。
 */
export default async function EditorIndexPage() {
  await requireRole(EDITOR_ROLES);
  const classList = await withSession((tx) => getSchoolClasses(tx));

  return (
    <div>
      <h1 style={{ fontSize: "1.4rem", marginBottom: "1rem" }}>エディタ — クラスを選択</h1>
      {classList.length === 0 ? (
        <p style={{ color: "#6b7280" }}>
          クラスがまだありません。<Link href="/admin/school">学校管理</Link>で追加してください。
        </p>
      ) : (
        <ul
          style={{
            display: "grid",
            gap: "0.5rem",
            listStyle: "none",
            padding: 0,
            maxWidth: "480px",
          }}
        >
          {classList.map((c) => (
            <li key={c.id}>
              <Link
                href={`/admin/editor/${c.id}`}
                style={{
                  display: "block",
                  padding: "0.6rem 0.9rem",
                  border: "1px solid #e5e7eb",
                  borderRadius: "8px",
                  textDecoration: "none",
                  color: "#1f2937",
                }}
              >
                {c.academicYear} 年度 — {c.name}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
