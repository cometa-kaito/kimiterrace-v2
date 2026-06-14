import { AppShell } from "@/app/_components/AppShell";
import { requireRole } from "@/lib/auth/guard";
import { enforceMfaGate } from "@/lib/mfa/enforce-gate";
import { PATHNAME_HEADER } from "@/lib/mfa/policy";
import { ADMIN_ROLES } from "@/lib/nav";
import { headers } from "next/headers";
import type { ReactNode } from "react";

/**
 * `/app` 配下 (学校コンソール) の共通レイアウト。
 *
 * **namespace 改称の出自**: 旧 `/admin/{editor,school,contents,chat,teacher-input}` を物理改称したもの
 * (経路設計実装設計書 §4.1/§42.5)。旧パスは `app/admin/layout.tsx` (AdminLayout) 配下にあり、本レイアウトは
 * そのゲート挙動を **そのまま**引き継ぐ (rename only・挙動不変)。旧 URL は `next.config.ts` の 308 redirect
 * (`/admin/<prefix>/:path*`→`/app/<prefix>/:path*`) で温存する。
 *
 * - **認可ゲート**: `requireRole(ADMIN_ROLES)` で 401 (未認証→/login) / 403 (生徒・保護者→/forbidden) を
 *   一括処理。`/app` 配下の各ページは個別に `requireRole(EDITOR_ROLES / PUBLISHER_ROLES / SCHOOL_ADMIN 等)`
 *   で更に絞るため、ここを ADMIN_ROLES に保つのは旧 AdminLayout と完全同一の挙動 (深層防御の早期ゲート、
 *   最終防衛は RLS)。
 * - **MFA 強制ゲート (F11, ADR-031)**: `enforceMfaGate` (既定 OFF) を旧レイアウトと同条件で適用。
 * - **共通シェル**: `AppShell` は `/admin`・`/ops` と共有 (app/_components/)。nav は role 別に解決される。
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await requireRole(ADMIN_ROLES);
  // 現在パスは middleware が注入したヘッダから読む (enrollment ページでのループ防止用)。既定 OFF では未使用。
  const currentPath = (await headers()).get(PATHNAME_HEADER) ?? undefined;
  await enforceMfaGate(user, currentPath);
  return <AppShell user={user}>{children}</AppShell>;
}
