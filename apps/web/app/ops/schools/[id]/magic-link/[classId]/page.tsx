import { Breadcrumb } from "@/app/_components/Breadcrumb";
import { MagicLinkManager } from "@/app/app/editor/[classId]/magic-link/_components/MagicLinkManager";
import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { SYSTEM_ADMIN_ROLES } from "@/lib/system-admin/roles";
import { isUuid } from "@/lib/system-admin/schools-core";
import { findVisibleClass, getSchoolDetail, listClassMagicLinks } from "@kimiterrace/db";
import { notFound } from "next/navigation";

/**
 * システム管理者が**特定校の特定クラス**の生徒アクセスリンク (magic link) を発行・管理する画面
 * (`/ops/schools/{id}/magic-link/{classId}`)。**Server Component**。`/ops/schools/{id}/magic-link` の
 * クラス選択からの遷移先。
 *
 * **認可**: `/ops` layout の `requireRole(ADMIN_ROLES)` に加え `requireRole(SYSTEM_ADMIN_ROLES)`
 * (system_admin のみ。school_admin は自校の `/app/editor/{classId}/magic-link` を使う)。
 *
 * **対象校スコープ (ADR-019 §#95 / ads・quiet_hours の /ops 経路と同型)**: 一覧データは
 * `withSession(..., { tenantScoped: true, schoolId })` の**対象校 RLS tx** で取得し、actor (system_admin) を
 * tx 内で school_admin に降格して対象校以外を不可視にする（URL の学校とクラスの整合を強制 = 他校 class は
 * 404）。発行 / 失効 / 延長は client が既存 API (`POST /api/magic-links` 他) を叩く。API 側は対象クラスから
 * 学校を解決し `system_admin_full_access` 下で発行する（監査 actor は actor_user_id=null + actor_identity_uid、
 * 平文トークンは発行レスポンスのみ・ルール5）。校名・存在確認は全校読取の `getSchoolDetail` で行い、不正 /
 * 不存在 id は 404。
 */
export default async function SystemSchoolClassMagicLinkPage({
  params,
}: {
  params: Promise<{ id: string; classId: string }>;
}) {
  await requireRole(SYSTEM_ADMIN_ROLES);
  const { id, classId } = await params;
  if (!isUuid(id) || !isUuid(classId)) {
    notFound();
  }

  // 校名・存在確認 (system_admin の全校読取、tenantScoped なし)。不存在 / 不可視は 404。
  const detail = await withSession((tx) => getSchoolDetail(tx, id)).catch(() => null);
  if (!detail) {
    notFound();
  }
  const { school } = detail;

  // 対象校に降格スコープした tx でクラス + 既存リンクを読む (他校 class は不可視 → not found 扱い)。
  const data = await withSession(
    async (tx) => {
      const cls = await findVisibleClass(tx, classId);
      if (!cls) {
        return null;
      }
      const links = await listClassMagicLinks(tx, classId);
      return {
        className: cls.name,
        links: links.map((l) => ({
          id: l.id,
          // ADR-042 PR1: expiresAt は型上 Date | null になったが、無期限リンクの発行 (NULL 書込) は
          // PR2 で導入する。PR1 時点で存在するのは全て期限つきリンクのため実行時 non-null。
          // NULL 無期限の UI 表示 (MagicLinkManager の型/表示) は PR3 で対応する。
          // biome-ignore lint/style/noNonNullAssertion: PR1 時点の発行リンクは全て期限つき
          expiresAt: l.expiresAt!.toISOString(),
          createdAt: l.createdAt.toISOString(),
        })),
      };
    },
    { tenantScoped: true, schoolId: school.id },
  );

  // クラスが対象校に存在しない (別テナント / 不存在) なら 404。
  if (!data) {
    notFound();
  }

  return (
    <div style={pageStyle}>
      <Breadcrumb
        items={[
          { label: "学校一覧", href: "/ops/schools" },
          { label: school.name, href: `/ops/schools/${school.id}` },
          { label: "生徒アクセスリンク", href: `/ops/schools/${school.id}/magic-link` },
          { label: data.className },
        ]}
      />

      <div role="note" style={bannerStyle}>
        <span aria-hidden="true">🛡</span>
        <span>
          <strong>
            システム管理者として「{school.name}」{data.className}{" "}
            の生徒アクセスリンクを管理しています。
          </strong>
          <br />
          発行・失効・延長はすべて監査ログに記録されます。発行時の URL
          はその場限りで再表示できません。
        </span>
      </div>

      <h1 style={titleStyle}>{data.className} の生徒アクセスリンク</h1>
      <p style={subtitleStyle}>
        生徒がサイネージ / 掲示物に匿名アクセスするための magic link
        を発行・失効します。発行時に表示される URL は<strong>その場限り</strong>
        です（後から再表示できません）。漏洩に気づいたら直ちに失効してください。
      </p>
      <MagicLinkManager classId={classId} initialLinks={data.links} />
    </div>
  );
}

const pageStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: "1rem" };
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
const titleStyle: React.CSSProperties = { fontSize: "1.4rem", fontWeight: 700, margin: 0 };
const subtitleStyle: React.CSSProperties = { color: "#6b7280", fontSize: "0.9rem", margin: 0 };
