import { requireRole } from "@/lib/auth/guard";
import { ADMIN_ROLES, homePathForRole } from "@/lib/nav";
import { redirect } from "next/navigation";

/**
 * `/admin` 着地ページ (#48-C)。V1 の `/manage` → role 別ダッシュボード分岐を踏襲し、
 * 認可済み role のホーム (`homePathForRole`) へ即リダイレクトする。
 *
 * layout で既に `requireRole` を通すが、page でも同じガードを掛けて
 * 「page を直接レンダリングする経路でも role 解決が保証される」状態にしておく。
 */
export default async function AdminIndexPage() {
  const user = await requireRole(ADMIN_ROLES);
  redirect(homePathForRole(user.role));
}
