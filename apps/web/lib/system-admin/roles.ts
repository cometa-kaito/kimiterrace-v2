import type { TenantRole } from "@kimiterrace/db";

/**
 * #48-L: システム管理画面 (`/ops/*`) を許可するロール集合。
 *
 * 横断運用 (全校マスタの閲覧/管理) は **system_admin のみ**。school_admin / teacher は自校スコープの
 * `/app/school`・`/app/editor` 側に閉じる (nav.ts の NAV_BY_ROLE と整合)。実データの越境は
 * schools の RLS (`system_admin_full_access`、ADR-019) が DB レベルで強制し、本集合は UX 層の早期
 * gate (`requireRole`) に使う (多層防御、CLAUDE.md ルール2)。
 *
 * `satisfies readonly TenantRole[]` で `@kimiterrace/db` の役割型とズレないことをコンパイル時に担保
 * (型のみ import、Next バンドルにランタイム値を引き込まない)。
 */
export const SYSTEM_ADMIN_ROLES = ["system_admin"] as const satisfies readonly TenantRole[];
