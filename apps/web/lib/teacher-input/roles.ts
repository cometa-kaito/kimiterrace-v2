import type { TenantRole } from "@kimiterrace/db";

/**
 * F02: 教員入力 (teacher_inputs) を操作・閲覧できるロール = **school_admin のみ**（指摘ログ finding⑧）。
 *
 * teacher_inputs は **掲示物 Q&A(RAG) の知識源**となる音声/テキスト/ファイル入力であり、サイネージ盤面
 * (daily_data) とは**別系統**。教員 UX はエディタ 1 枚（会話型 AI 内包）に集約し、教員からは teacher-input を
 * 撤去する（**teacher を除外**）。Q&A/RAG 用コンテンツの投入は学校管理者に集約（ADR-038 と整合）。
 *
 * 生徒 (student) / 保護者 (guardian) は **不可**。`teacher_inputs` の RLS は `tenant_isolation` (school 境界) と
 * `system_admin_full_access` のみで **role 境界を守らない**ため、role による拒否はここ + handler で行う
 * (magic-links の `isIssuerRole` と同型)。system_admin は school 非所属 (schoolId=null) でテナント内データを
 * 持てず deny-by-default で 0 件化するため除外。`satisfies` で TenantRole の妥当性を担保する (ルール3)。
 */
export const TEACHER_INPUT_STAFF_ROLES = ["school_admin"] as const satisfies readonly TenantRole[];

/** role が教員入力を扱える staff ロールかの純粋判定 (副作用なし)。 */
export function isTeacherInputRole(role: TenantRole): boolean {
  return (TEACHER_INPUT_STAFF_ROLES as readonly TenantRole[]).includes(role);
}
