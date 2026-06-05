import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { EDITOR_ROLES } from "@/lib/editor/schedule-core";
import { getSchoolClasses } from "@/lib/editor/schedule-queries";
import Link from "next/link";

/**
 * エディタ着地 (#48-H)。編集対象クラスを選ぶ。`/admin/editor/[classId]` で時間割編集へ。
 * Notice / Assignment セクション (#48-I) も同じクラス別エディタに後続で追加される想定。
 *
 * **空状態の導線はロール別 (校務DX原則: 教員に新たな工数を発生させない)**: クラスが 0 件のとき、
 * 従来は全ロールに「学校管理」(`/admin/school`) リンクを出していたが、`/admin/school` は
 * `SCHOOL_HIERARCHY_ROLES` (school_admin / system_admin) 専用で **teacher は含まれない**ため、teacher が
 * クリックすると 403 (`/forbidden`) に倒れる
 * 行き止まりだった。クラス設定は学校管理者の仕事であり教員の校務ではないため、teacher にはアクセス
 * できない導線を出さず「管理者が追加すると表示される」案内に留める。
 */
export default async function EditorIndexPage() {
  const user = await requireRole(EDITOR_ROLES);
  const classList = await withSession((tx) => getSchoolClasses(tx));

  return (
    <div>
      <h1 style={{ fontSize: "1.4rem", marginBottom: "1rem" }}>エディタ — クラスを選択</h1>
      {classList.length === 0 ? (
        user.role === "school_admin" ? (
          // 学校管理者は /admin/school にアクセスできるので、クラス追加への導線を出す。
          <p style={{ color: "#6b7280" }}>
            クラスがまだありません。<Link href="/admin/school">学校管理</Link>で追加してください。
          </p>
        ) : (
          // 教員は /admin/school にアクセスできない (403)。行き止まりリンクを出さず、管理者の作業待ちで
          // ここに表示されることだけ案内する (校務DX原則: 教員にクラス設定の工数を負わせない)。
          <p style={{ color: "#6b7280" }}>
            まだクラスがありません。学校管理者がクラスを追加すると、ここに表示されます。
          </p>
        )
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
