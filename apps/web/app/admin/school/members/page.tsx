import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { type RoleActor, canModifyTargetUser } from "@/lib/role-management/policy";
import { MEMBER_ADMIN_ROLES } from "@/lib/role-management/roles";
import { type TenantRole, listSchoolMembers } from "@kimiterrace/db";
import Link from "next/link";
import { MemberActiveToggle } from "./_components/MemberActiveToggle";

/**
 * F11 (#47) 第2スライス: 自校 **教職員一覧** (`/admin/school/members`)。**Server Component**。
 *
 * 第1スライス (#275) が確立したロール管理の認可ポリシー (`canModifyTargetUser` 等) を消費し、
 * 学校管理者 (school_admin) が自校の教職員 (school_admin / teacher) を一覧して「誰のロールを
 * 管理できるか」を把握できるようにする。ロールの付与/変更/無効化の **操作系** は後続スライス。
 *
 * **認可 / スコープ**: `requireRole(["school_admin"])` で **school_admin 専用** (teacher / system_admin は
 * 403 `/forbidden`)。本ビューは school_admin の **自校運用**で、system_admin の全校横断ユーザー管理は
 * `/admin/system/` 配下の別スライスに分ける (system_admin context だと `users` の
 * `system_admin_full_access` が全校 PII を返すため、自校ビューに混ぜない。advertisers/dashboard と同じ
 * per-surface スコープ方針、[[rls-tenant-not-role-boundary]])。`withSession({allowedRoles})` で二段 gate、
 * 可視範囲は `users` の RLS (`tenant_isolation`) が DB レベルで自校に絞る (CLAUDE.md ルール2、多層防御)。
 *
 * **管理可否の表示 + 操作 (#324)**: 各行に `canModifyTargetUser` の判定を出す。school_admin は自校 teacher
 * のみ管理可で、school_admin (自分/同僚) 行は不可 — ポリシーの単一ソースを UI でもそのまま使う (ルール3)。
 * 管理可の行には **無効化 / 再有効化トグル** ({@link MemberActiveToggle}) を出す。エンフォースは IdP
 * (claims 失効) が単一ソースで、DB の `is_active` は mirror (ADR-026)。`MEMBER_ADMIN_ROLES` は操作系
 * Server Action と共有する単一ソース (`@/lib/role-management/roles`)。
 *
 * **PII (ルール4)**: 表示名・ロール・状態のみ。email 等は一覧では出さない (query 層で射影制限)。
 *
 * **アクセシビリティ (NFR05 / WCAG 2.2 AA)**: `<table>` + `<th scope>`、状態は文字ラベルで色非依存。
 */

export default async function SchoolMembersPage() {
  const user = await requireRole(MEMBER_ADMIN_ROLES);
  const members = await withSession((tx) => listSchoolMembers(tx), {
    allowedRoles: MEMBER_ADMIN_ROLES,
  });

  // 管理可否判定の主体。school_admin は自校 (user.schoolId) スコープ。全行は RLS で自校なので、
  // 対象校 = 自校として canModifyTargetUser を評価する。
  const actor: RoleActor = { role: user.role, schoolId: user.schoolId };
  const activeCount = members.filter((m) => m.isActive).length;

  return (
    <section>
      <header style={headerStyle}>
        <h1 style={titleStyle}>教職員</h1>
        <span style={countStyle}>
          稼働 {activeCount} / 全 {members.length} 名
        </span>
        <Link href="/admin/school/members/new" style={newLinkStyle}>
          ＋ teacher を発行
        </Link>
      </header>
      <p style={subtitleStyle}>
        自校の教職員のロール状況です。「管理可」の行ではアカウントの無効化 /
        再有効化を行えます（無効化は認証を即時停止します）。ロールの変更は順次追加します。
      </p>

      {members.length === 0 ? (
        <p style={emptyStyle}>自校に登録されている教職員がいません。</p>
      ) : (
        <table style={tableStyle}>
          <caption style={captionStyle}>稼働中 → ロール → 表示名の順</caption>
          <thead>
            <tr>
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
                管理
              </th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => {
              const decision = canModifyTargetUser(actor, {
                targetCurrentRole: m.role,
                targetSchoolId: user.schoolId,
              });
              return (
                <tr key={m.id}>
                  <th scope="row" style={tdLeftStyle}>
                    {m.displayName}
                  </th>
                  <td style={tdStyle}>{roleLabel(m.role)}</td>
                  <td style={tdStyle}>
                    <StatusBadge isActive={m.isActive} />
                  </td>
                  <td style={tdStyle}>
                    {decision.allowed ? (
                      <MemberActiveToggle
                        userId={m.id}
                        isActive={m.isActive}
                        displayName={m.displayName}
                      />
                    ) : (
                      <span style={notManageableStyle}>管理対象外</span>
                    )}
                  </td>
                </tr>
              );
            })}
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

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  marginBottom: "0.5rem",
};
const titleStyle: React.CSSProperties = { fontSize: "1.3rem", fontWeight: 700, margin: 0 };
const countStyle: React.CSSProperties = { fontSize: "0.85rem", color: "#6b7280" };
const newLinkStyle: React.CSSProperties = {
  marginLeft: "auto",
  fontSize: "0.85rem",
  color: "#1d4ed8",
  textDecoration: "none",
  fontWeight: 600,
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
const notManageableStyle: React.CSSProperties = { fontSize: "0.8rem", color: "#9ca3af" };
