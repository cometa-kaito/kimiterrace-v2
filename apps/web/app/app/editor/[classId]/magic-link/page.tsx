import { Breadcrumb } from "@/app/_components/Breadcrumb";
import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { MAGIC_LINK_ISSUER_ROLES } from "@/lib/magic-link/request";
import { findVisibleClass, listClassMagicLinks } from "@kimiterrace/db";
import { notFound } from "next/navigation";
import { MagicLinkManager } from "./_components/MagicLinkManager";

/**
 * F05 (#41): クラス magic link 発行 / 管理ページ `/app/editor/{classId}/magic-link`。
 *
 * `/admin` 配下 (#48-C layout で認証) + 本ページで `MAGIC_LINK_ISSUER_ROLES` (**school_admin / system_admin**)
 * に限定 (teacher / 生徒 / 保護者は 403 → /forbidden。教員除外は finding④)。magic_links の RLS は school 境界
 * のみで role 境界を守らないため、role 拒否は API handler と本ページの二層で行う ([[rls-tenant-not-role-boundary]]
 * / request.ts と同一集合)。system_admin は `system_admin_full_access` で他校クラスも可視（cross-tenant 運用）。
 * school_admin にとって別テナントのクラスは RLS 不可視 → 404。
 *
 * 既存リンク一覧は本ページ (server) が自校 RLS tx で読み、発行 / 失効は client が既存 API
 * (`POST /api/magic-links` / `POST /api/magic-links/{id}/revoke`) を叩く (ADR-008)。
 * **平文トークンは発行レスポンスでしか取得できない** (DB は hash のみ、ルール5) ため、一覧には
 * メタ情報のみを渡し、新規発行時の 1 回限りの URL は client で表示する。
 */
export default async function ClassMagicLinkPage({
  params,
}: {
  params: Promise<{ classId: string }>;
}) {
  const user = await requireRole(MAGIC_LINK_ISSUER_ROLES);
  const { classId } = await params;

  const data = await withSession(async (tx) => {
    const cls = await findVisibleClass(tx, classId);
    if (!cls) {
      return null;
    }
    const links = await listClassMagicLinks(tx, classId);
    return {
      className: cls.name,
      links: links.map((l) => ({
        id: l.id,
        expiresAt: l.expiresAt.toISOString(),
        createdAt: l.createdAt.toISOString(),
      })),
    };
  });

  // クラスが自校で不可視 (別テナント / 存在しない) なら 404。
  if (!data) {
    notFound();
  }

  // パンくずの中間 crumb は role 別 (ads ページと同規律): system_admin はエディタ
  // (EDITOR_ROLES=teacher/school_admin) で 403 になるため「学校一覧」(/ops/schools) を親に置き、クラス名は
  // 死リンク回避で非リンク。school_admin はエディタ → このクラスの編集へ辿れる従来導線を保つ。
  const editorCrumbs =
    user.role === "system_admin"
      ? [{ label: "学校一覧", href: "/ops/schools" }, { label: data.className }]
      : [
          { label: "エディタ", href: "/app/editor" },
          { label: data.className, href: `/app/editor/${classId}` },
        ];

  return (
    <div>
      <Breadcrumb items={[...editorCrumbs, { label: "生徒アクセスリンク" }]} />
      <h1 style={{ fontSize: "1.4rem", margin: "0.5rem 0 0.25rem" }}>
        {data.className} の生徒アクセスリンク
      </h1>
      <p style={{ color: "#6b7280", margin: "0 0 1rem", fontSize: "0.9rem" }}>
        生徒がサイネージ / 掲示物に匿名アクセスするための magic link
        を発行・失効します。発行時に表示される URL は<strong>その場限り</strong>
        です（後から再表示できません）。漏洩に気づいたら直ちに失効してください。
      </p>
      <MagicLinkManager classId={classId} initialLinks={data.links} />
    </div>
  );
}
