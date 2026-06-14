import { requireRole } from "@/lib/auth/guard";
import { ADMIN_ROLES, homePathForRole } from "@/lib/nav";
import { redirect } from "next/navigation";

/**
 * `/app` 着地ページ (#48-C、旧 `/admin` を §4.1 改称)。V1 の `/manage` → role 別ダッシュボード分岐を踏襲し、
 * 認可済み role のホーム (`homePathForRole`: school_admin→/app/school・teacher→/app/editor・system_admin→/ops/schools)
 * へ即リダイレクトする。旧 `/admin` 入口は next.config の catch-all 308 で `/app` へ転送され本ページに着地する。
 *
 * layout で既に `requireRole` を通すが、page でも同じガードを掛けて
 * 「page を直接レンダリングする経路でも role 解決が保証される」状態にしておく。
 */
export default async function AppIndexPage() {
  const user = await requireRole(ADMIN_ROLES);
  redirect(homePathForRole(user.role));
}
