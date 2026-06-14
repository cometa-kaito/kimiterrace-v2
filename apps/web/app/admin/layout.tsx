import { requireRole } from "@/lib/auth/guard";
import { enforceMfaGate } from "@/lib/mfa/enforce-gate";
import { PATHNAME_HEADER } from "@/lib/mfa/policy";
import { ADMIN_ROLES } from "@/lib/nav";
import { headers } from "next/headers";
import type { ReactNode } from "react";
// 共通シェルは namespace 改称 (/admin/system→/ops、/admin→/app) に伴い、複数 namespace の layout から
// 共有するため `app/_components/` (中立) へ移設した。/ops/layout.tsx も同じ AppShell を import する。
import { AppShell } from "@/app/_components/AppShell";

/**
 * `/admin` 配下の共通レイアウト (#48-C)。**Server Component**。
 *
 * - **認可ゲート**: `requireRole(ADMIN_ROLES)` で 401 (未認証→/login) / 403 (生徒・保護者→/forbidden)
 *   を一括処理。middleware は cookie 存在チェックのみ (Edge 制約) なので、claims 検証込みの
 *   最終ゲートはここ (deny-by-default、ADR-003 / ADR-019)。
 * - **MFA 強制ゲート (F11, ADR-031)**: `enforceMfaGate` で未登録の teacher 以上を enrollment へ誘導。
 *   **既定 OFF** (`MFA_ENFORCEMENT` env が `"on"` でなければ IdP も叩かず即 return) なので、PoC /
 *   既存環境では一切の挙動変化が無い (回帰なし)。本番導入ゲートで env を切り替えて初めて効く。
 * - **共通シェル**: 認可済み user を `AppShell` に渡し、role 別ナビ + ヘッダで包む。
 *
 * 実データの越境は RLS が DB レベルで止める (ルール2)。本レイアウトは UX 層の早期ゲート。
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const user = await requireRole(ADMIN_ROLES);
  // 現在パスは middleware が注入したヘッダから読む (enrollment ページでのループ防止用)。既定 OFF では未使用。
  const currentPath = (await headers()).get(PATHNAME_HEADER) ?? undefined;
  await enforceMfaGate(user, currentPath);
  return <AppShell user={user}>{children}</AppShell>;
}
