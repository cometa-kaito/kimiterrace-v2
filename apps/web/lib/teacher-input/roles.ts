import type { TenantRole } from "@kimiterrace/db";

/**
 * F02: 教員入力 (teacher_inputs) を操作・閲覧できるロール (pure、副作用なし = mock 不要で unit テスト可能)。
 *
 * 生徒 (student) / 保護者 (guardian) は **不可** — 認可境界の第一層 (ルール2 多層防御の UX / 早期 deny 側)。
 * `teacher_inputs` の RLS は `tenant_isolation` (school 境界) と `system_admin_full_access` のみで
 * **role 境界を守らない**ため、role による拒否はここ + handler で行う (magic-links の `isIssuerRole` と同型)。
 * system_admin は school 非所属 (schoolId=null) でテナント内データを持てず、`withTenantContext` の
 * deny-by-default が別途 0 件化するため許可集合から除外する。
 * `satisfies` で TenantRole の妥当性をコンパイル時に担保する (ルール3、誤記すると build が落ちる)。
 */
export const TEACHER_INPUT_STAFF_ROLES = [
  "teacher",
  "school_admin",
] as const satisfies readonly TenantRole[];

/** role が教員入力を扱える staff ロールかの純粋判定 (副作用なし)。 */
export function isTeacherInputRole(role: TenantRole): boolean {
  return (TEACHER_INPUT_STAFF_ROLES as readonly TenantRole[]).includes(role);
}
