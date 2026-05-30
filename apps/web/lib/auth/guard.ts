import type { TenantRole } from "@kimiterrace/db";
import { redirect } from "next/navigation";
import { type AuthUser, getCurrentUser } from "./session";

/**
 * 認可ガード (#48-C、401/403 ハンドリング)。**サーバー専用** (getCurrentUser が next/headers を使う)。
 *
 * 二段の防衛線:
 * - **401 (未認証)**: `requireUser()` — session が無い/無効なら `/login?next=` に redirect。
 *   middleware は cookie 存在チェックのみ (Edge 制約、ADR-003) なので、cookie はあるが中身が
 *   無効なケースはここが最終ゲート (deny-by-default)。
 * - **403 (権限不足)**: `requireRole()` — 認証済みだが role が許可集合に無ければ `/forbidden` に redirect。
 *
 * 認可の**本体は RLS** (ADR-019)。本ガードは「画面を見せない / 早期に弾く」UX 層であり、
 * 実データ越境は RLS が DB レベルで止める (CLAUDE.md ルール2、多層防御)。
 */

/** role が許可集合に含まれるかの純粋判定 (テスト用に分離、redirect 副作用を持たない)。 */
export function isRoleAllowed(role: TenantRole, allowed: readonly TenantRole[]): boolean {
  return allowed.includes(role);
}

/**
 * 認証必須。未認証なら `/login` に redirect (戻り先を next= に載せる)。
 * @param nextPath ログイン後に戻すパス (保護ページが自分のパスを渡す)。省略時は `/admin`。
 * @returns 認証済み AuthUser (redirect した場合は戻らない)
 */
export async function requireUser(nextPath = "/admin"): Promise<AuthUser> {
  const user = await getCurrentUser();
  if (!user) {
    redirect(`/login?next=${encodeURIComponent(nextPath)}`);
  }
  return user;
}

/**
 * 認証 + role 必須。未認証は `/login`、role 不足は `/forbidden` に redirect。
 * @param allowed 許可するロール集合 (例: `ADMIN_ROLES`)
 * @param nextPath 未認証時のログイン後戻り先
 * @returns 認可済み AuthUser (redirect した場合は戻らない)
 */
export async function requireRole(
  allowed: readonly TenantRole[],
  nextPath = "/admin",
): Promise<AuthUser> {
  const user = await requireUser(nextPath);
  if (!isRoleAllowed(user.role, allowed)) {
    redirect("/forbidden");
  }
  return user;
}
