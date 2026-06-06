import { getCurrentUser } from "@/lib/auth/session";
import { homePathForRole } from "@/lib/nav";
import { redirect } from "next/navigation";

/**
 * ルート (`/`)。未認証は middleware が `/login` に振り分けるが、認証済みのユーザーが到達した場合に
 * 旧「scaffold placeholder」を見せないよう、ロール別ホーム（`homePathForRole`）へ送る。
 *
 * - 未認証 (middleware をすり抜けた防御的ケース) → `/login`。
 * - 認証済み → system_admin: `/admin/system/schools` / school_admin: `/admin/school` /
 *   teacher: `/admin/editor`。
 * - 管理エリア対象外ロール (student/guardian、`homePathForRole` が `/`) は無限リダイレクトを避けて
 *   `/login` に倒す（セッション cookie を持つのは職員/管理者のみで通常到達しない）。
 */
export default async function HomePage() {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }
  const home = homePathForRole(user.role);
  redirect(home === "/" ? "/login" : home);
}
