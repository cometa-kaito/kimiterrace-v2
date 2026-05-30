import { requireRole } from "@/lib/auth/guard";
import { ADMIN_ROLES } from "@/lib/nav";
import type { ReactNode } from "react";
import { AppShell } from "./_components/AppShell";

/**
 * `/admin` 配下の共通レイアウト (#48-C)。**Server Component**。
 *
 * - **認可ゲート**: `requireRole(ADMIN_ROLES)` で 401 (未認証→/login) / 403 (生徒・保護者→/forbidden)
 *   を一括処理。middleware は cookie 存在チェックのみ (Edge 制約) なので、claims 検証込みの
 *   最終ゲートはここ (deny-by-default、ADR-003 / ADR-019)。
 * - **共通シェル**: 認可済み user を `AppShell` に渡し、role 別ナビ + ヘッダで包む。
 *
 * 実データの越境は RLS が DB レベルで止める (ルール2)。本レイアウトは UX 層の早期ゲート。
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const user = await requireRole(ADMIN_ROLES);
  return <AppShell user={user}>{children}</AppShell>;
}
