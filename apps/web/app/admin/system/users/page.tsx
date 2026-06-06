import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { SYSTEM_ADMIN_ROLES } from "@/lib/system-admin/roles";
import { type TenantRole, listAllStaff } from "@kimiterrace/db";
import Link from "next/link";
import { StaffActiveToggle } from "./_components/StaffActiveToggle";
import { StaffRoleToggle } from "./_components/StaffRoleToggle";

/**
 * F11 (#47 / #324): システム管理者の **全校横断 教職員一覧** (`/admin/system/users`)。**Server Component**。
 *
 * `/admin/school/members` (#318) が school_admin の **自校**ビューなのに対し、本ページは system_admin の
 * **全校横断**ビュー。ADR-026 のロール変更 / アカウント無効化 操作系 (D2 / 全校無効化 + last-admin ガード)
 * の土台となる read スライス (advertisers #270 と同じく「一覧 → 操作」の段階適用、本スライスは閲覧のみ)。
 *
 * **認可**: `/admin` レイアウトの `requireRole(ADMIN_ROLES)` に加え `requireRole(SYSTEM_ADMIN_ROLES)`
 * (system_admin のみ。school_admin / teacher は 403 `/forbidden`)。`withSession` の RLS context 下で
 * `listAllStaff` を呼ぶ — 可視範囲は `users` / `schools` の RLS (`system_admin_full_access`) が決め、
 * 手書き WHERE には依存しない (ルール2、多層防御)。
 *
 * **PII (ルール4)**: 表示名・ロール・状態・所属校のみ。email 等は一覧では出さない (query 層で射影制限)。
 * 表示名 (職員名) は system_admin がアカウント管理 (無効化 / ロール変更) で対象を識別するために必要。
 * 生徒・保護者は教職員ロールでないため一覧対象外。
 *
 * **アクセシビリティ (NFR05 / WCAG 2.2 AA)**: `<table>` + `<th scope>`、状態は文字ラベルで色非依存。
 */
export default async function SystemUsersPage() {
  await requireRole(SYSTEM_ADMIN_ROLES);
  const staff = await withSession((tx) => listAllStaff(tx));
  const activeCount = staff.filter((s) => s.isActive).length;
  const schoolCount = new Set(staff.map((s) => s.schoolId)).size;

  return (
    <section>
      <header style={headerStyle}>
        <h1 style={titleStyle}>教職員管理</h1>
        <div style={headerRightStyle}>
          <span style={countStyle}>
            {schoolCount} 校 / 稼働 {activeCount} / 全 {staff.length} 名
          </span>
          <Link href="/admin/system/users/new" style={newLinkStyle}>
            ＋ 教職員を発行
          </Link>
        </div>
      </header>
      <p style={subtitleStyle}>
        全校横断の教職員一覧です。各行でアカウントの無効化 / 再有効化とロール変更 (学校管理者 ⇄
        教員)
        を行えます。無効化・降格は認証を即時停止し再ログインを要求します。学校で唯一の有効な学校管理者は無効化・降格できません。
      </p>

      {staff.length === 0 ? (
        <p style={emptyStyle}>登録されている教職員がいません。</p>
      ) : (
        <table style={tableStyle}>
          <caption style={captionStyle}>学校 → ロール → 表示名の順</caption>
          <thead>
            <tr>
              <th scope="col" style={thLeftStyle}>
                学校
              </th>
              <th scope="col" style={thLeftStyle}>
                表示名
              </th>
              <th scope="col" style={thLeftStyle}>
                ロール
              </th>
              <th scope="col" style={thLeftStyle}>
                状態
              </th>
              <th scope="col" style={thLeftStyle}>
                操作
              </th>
            </tr>
          </thead>
          <tbody>
            {staff.map((s) => (
              <tr key={s.id}>
                <td style={tdStyle}>{s.schoolName}</td>
                <th scope="row" style={tdLeftStyle}>
                  {s.displayName}
                </th>
                <td style={tdStyle}>{roleLabel(s.role)}</td>
                <td style={tdStyle}>
                  <StatusBadge isActive={s.isActive} />
                </td>
                <td style={tdStyle}>
                  <span style={actionsCellStyle}>
                    <StaffActiveToggle
                      userId={s.id}
                      isActive={s.isActive}
                      displayName={s.displayName}
                      schoolName={s.schoolName}
                    />
                    {/* 一覧は教職員のみ (listAllStaff の role 絞り) だが TS narrowing のため明示判定。 */}
                    {(s.role === "school_admin" || s.role === "teacher") && (
                      <StaffRoleToggle
                        userId={s.id}
                        currentRole={s.role}
                        displayName={s.displayName}
                        schoolName={s.schoolName}
                      />
                    )}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** 稼働中 / 無効 (アカウント無効化) のステータスバッジ (色非依存で文字も出す)。 */
function StatusBadge({ isActive }: { isActive: boolean }) {
  return (
    <span style={isActive ? activeBadgeStyle : inactiveBadgeStyle}>
      {isActive ? "稼働中" : "無効"}
    </span>
  );
}

/** ロールの日本語ラベル。教職員ロールのみ一覧に出るが、網羅して将来のロール追加に備える。 */
function roleLabel(role: TenantRole): string {
  switch (role) {
    case "system_admin":
      return "システム管理者";
    case "school_admin":
      return "学校管理者";
    case "teacher":
      return "教員";
    case "student":
      return "生徒";
    case "guardian":
      return "保護者";
    default:
      return role;
  }
}

const actionsCellStyle: React.CSSProperties = {
  display: "inline-flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: "0.3rem",
};
const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  marginBottom: "0.5rem",
};
const titleStyle: React.CSSProperties = { fontSize: "1.3rem", fontWeight: 700, margin: 0 };
const countStyle: React.CSSProperties = { fontSize: "0.85rem", color: "#6b7280" };
const headerRightStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "1rem",
};
const newLinkStyle: React.CSSProperties = {
  fontSize: "0.85rem",
  color: "#fff",
  background: "#1d4ed8",
  padding: "0.4rem 0.9rem",
  borderRadius: "6px",
  textDecoration: "none",
};
const subtitleStyle: React.CSSProperties = { color: "#6b7280", margin: "0 0 1.25rem" };
const emptyStyle: React.CSSProperties = { color: "#6b7280" };
const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "0.9rem",
};
const captionStyle: React.CSSProperties = {
  textAlign: "left",
  color: "#6b7280",
  fontSize: "0.8rem",
  marginBottom: "0.5rem",
};
const thLeftStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "0.5rem 0.6rem",
  borderBottom: "2px solid #e5e7eb",
  fontWeight: 600,
};
const tdLeftStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "0.5rem 0.6rem",
  borderBottom: "1px solid #f3f4f6",
  fontWeight: 500,
};
const tdStyle: React.CSSProperties = {
  padding: "0.5rem 0.6rem",
  borderBottom: "1px solid #f3f4f6",
};
const activeBadgeStyle: React.CSSProperties = {
  fontSize: "0.75rem",
  padding: "0.1rem 0.5rem",
  borderRadius: "999px",
  background: "#dcfce7",
  color: "#166534",
};
const inactiveBadgeStyle: React.CSSProperties = {
  fontSize: "0.75rem",
  padding: "0.1rem 0.5rem",
  borderRadius: "999px",
  background: "#f3f4f6",
  color: "#6b7280",
};
