import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { SYSTEM_ADMIN_ROLES } from "@/lib/system-admin/roles";
import { listSchools } from "@kimiterrace/db";
import Link from "next/link";
import { SystemStaffCreateForm } from "./_components/SystemStaffCreateForm";

/**
 * F11 (#508): システム管理者の **教職員発行** (`/ops/users/new`)。**Server Component**。
 *
 * **認可**: `/admin` layout の `requireRole(ADMIN_ROLES)` に加え `requireRole(SYSTEM_ADMIN_ROLES)`
 * (system_admin のみ)。任意校への school_admin 発行は横断運用なので system_admin 専用。教員は学校共通PW
 * (ADR-032・系統A) でログインし個別アカウントを持たないため発行対象でない (教員アカウント概念の撤去)。
 *
 * 発行先の学校プルダウン用に `listSchools` を RLS tx (system_admin context = 全校可視) で取得し、
 * client に渡せる最小フィールド (id / name / prefecture) に射影する (Date 等の非シリアライズ値や
 * 不要な PII を client へ渡さない)。入力収集と発行は `SystemStaffCreateForm` (Client) →
 * `createSystemStaffAction` (Server Action)。検証・対象校実在確認・IdP 作成・DB mirror・監査・RLS は
 * アクション側が担保する。
 */
export default async function SystemUserNewPage() {
  await requireRole(SYSTEM_ADMIN_ROLES);
  const schools = await withSession((tx) => listSchools(tx));
  const options = schools.map((s) => ({ id: s.id, name: s.name, prefecture: s.prefecture }));

  return (
    <section
      style={{ display: "flex", flexDirection: "column", gap: "1.25rem", maxWidth: "640px" }}
    >
      <Link href="/ops/users" style={backLinkStyle}>
        ← 教職員管理
      </Link>
      <h1 style={titleStyle}>教職員を発行</h1>
      <p style={subtitleStyle}>
        学校を選んで学校管理者アカウントを発行します。新規校では、まず「学校管理者」を 1
        人発行すると、その管理者でログインして学科・学年・クラスを登録できます。教員は学校共通パスワードでログインするため個別発行は不要です。
      </p>
      <SystemStaffCreateForm schools={options} />
    </section>
  );
}

const backLinkStyle: React.CSSProperties = {
  fontSize: "0.85rem",
  color: "#2563eb",
  textDecoration: "none",
};
const titleStyle: React.CSSProperties = { fontSize: "1.4rem", fontWeight: 700, margin: 0 };
const subtitleStyle: React.CSSProperties = { fontSize: "0.85rem", color: "#6b7280", margin: 0 };
