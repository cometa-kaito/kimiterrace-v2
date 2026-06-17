import { HierarchyManager } from "@/app/app/school/_components/HierarchyManager";
import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import {
  computeTodayActiveClasses,
  getSchoolHierarchy,
  getTodayDailyDataScopes,
} from "@/lib/school-admin/hub-queries";
import { SYSTEM_ADMIN_ROLES } from "@/lib/system-admin/roles";
import { isUuid } from "@/lib/system-admin/schools-core";
import { getSchoolDetail } from "@kimiterrace/db";
import Link from "next/link";
import { notFound } from "next/navigation";

/**
 * システム管理者が特定校のクラス設定 (学科 / 学年 / クラス階層) を編集する画面 (`/ops/schools/{id}/hierarchy`)。
 * **Server Component**。
 *
 * **認可**: `/ops` layout の `requireRole(ADMIN_ROLES)` に加え `requireRole(SYSTEM_ADMIN_ROLES)`
 * (system_admin のみ。school_admin は自校の `/app/school` を使う。teacher 等は 403)。
 *
 * **対象校スコープ (ADR-019 §#95)**: 階層データは `withSession(..., { tenantScoped: true, schoolId })`
 * の **対象校 RLS tx** で取得する。これにより actor (system_admin) は tx 内で school_admin に降格され、
 * 対象校以外は不可視・書込不可になる。編集 UI (`HierarchyManager`) には `schoolId` を渡し、各 Server
 * Action を対象校に結ぶ (越境防止のゲートはサーバ側 `toHubActor`/`withSession`)。校名・存在確認は
 * 全校読取の `getSchoolDetail` で行い、不正 / 不存在 id は 404。
 */
export default async function SystemSchoolHierarchyPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireRole(SYSTEM_ADMIN_ROLES);
  const { id } = await params;
  if (!isUuid(id)) {
    notFound();
  }
  // 校名・存在確認 (system_admin の全校読取、tenantScoped なし)。不存在 / 不可視は 404。
  const detail = await withSession((tx) => getSchoolDetail(tx, id)).catch(() => null);
  if (!detail) {
    notFound();
  }
  const { school } = detail;

  // 対象校に降格スコープした tx で階層を取得する (他校は不可視)。
  const { hierarchy, statusByClass } = await withSession(
    async (tx) => {
      const tree = await getSchoolHierarchy(tx);
      const scopes = await getTodayDailyDataScopes(tx);
      return { hierarchy: tree, statusByClass: computeTodayActiveClasses(scopes, tree.grades) };
    },
    { tenantScoped: true, schoolId: school.id },
  );

  return (
    <div style={pageStyle}>
      <nav style={breadcrumbStyle} aria-label="パンくず">
        <Link href="/ops/schools" style={crumbLinkStyle}>
          学校一覧
        </Link>
        <span aria-hidden="true">/</span>
        <Link href={`/ops/schools/${school.id}`} style={crumbLinkStyle}>
          {school.name}
        </Link>
        <span aria-hidden="true">/</span>
        <span style={crumbCurrentStyle}>クラス設定</span>
      </nav>

      <div role="note" style={bannerStyle}>
        <span aria-hidden="true">🛡</span>
        <span>
          <strong>システム管理者として「{school.name}」のクラス設定を編集しています。</strong>
          <br />
          この学校のテナント範囲に限定され、すべての追加・変更・削除は監査ログに記録されます。
        </span>
      </div>

      <HierarchyManager
        hierarchy={hierarchy}
        statusByClass={statusByClass}
        schoolId={school.id}
        heading={`クラス設定 — ${school.name}`}
      />
    </div>
  );
}

const pageStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: "1rem" };
const breadcrumbStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  fontSize: "0.85rem",
  color: "#6b7280",
  flexWrap: "wrap",
};
const crumbLinkStyle: React.CSSProperties = { color: "#2563eb", textDecoration: "none" };
const crumbCurrentStyle: React.CSSProperties = { color: "#1c1917" };
const bannerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: "0.6rem",
  background: "#fef9c3",
  border: "1px solid #fde68a",
  borderRadius: "8px",
  padding: "0.75rem 0.9rem",
  fontSize: "0.85rem",
  lineHeight: 1.6,
  color: "#854d0e",
};
