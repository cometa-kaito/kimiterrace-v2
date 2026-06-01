import type { TenantRole } from "@kimiterrace/db";

/**
 * F11 (#47): 自校教職員のロール管理面 (`/admin/school/members`) を許可するロール集合。
 *
 * 自校運用は **school_admin のみ**。teacher は閲覧/操作権限を持たず、system_admin の全校横断ユーザー
 * 管理は `/admin/system/*` 側の別面に分ける (`users` の `system_admin_full_access` が全校 PII を返すため
 * 自校ビューに混ぜない、[[rls-tenant-not-role-boundary]] / advertisers・dashboard と同じ per-surface 方針)。
 * 実データ越境は `users` の RLS (`tenant_isolation`、ADR-019) が DB レベルで止め、本集合は UX 層の早期
 * gate (`requireRole`) と Server Action の認可第一層に使う (多層防御、CLAUDE.md ルール2)。
 *
 * `satisfies readonly TenantRole[]` で `@kimiterrace/db` の役割型とズレないことをコンパイル時に担保
 * (型のみ import、Next バンドルにランタイム値を引き込まない、ルール3)。
 *
 * 一覧画面 (`members/page.tsx`) と操作系 Server Action (`member-actions.ts`) が同じ集合を消費する
 * 単一ソース。
 */
export const MEMBER_ADMIN_ROLES = ["school_admin"] as const satisfies readonly TenantRole[];
