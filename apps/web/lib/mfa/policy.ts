import type { TenantRole } from "@kimiterrace/db";

/**
 * F11 (#47, ADR-031): MFA capability の **純粋ロジック・型・定数**。
 *
 * **副作用なし** (cookie / DB / firebase を持ち込まない)。MFA 対象ロール判定などを純関数で表現し、
 * node 環境の unit テストで網羅検証できるようにする (`lib/nav.ts` と同方針)。エンフォースの単一ソースは
 * IdP (ADR-031 §4 / ADR-026)。本モジュールは判定・定数だけを担い、登録の真実 (enrolledFactors) は
 * `lib/auth/mfa-admin.ts` が IdP から読む。
 *
 * **型の単一ソース (ルール3)**: role 型は `@kimiterrace/db` の `TenantRole` を型のみ import する
 * (ビルド時に消去、Next バンドルにランタイム値を引き込まない)。
 *
 * 注: 強制ゲート (env フラグ解釈・誘導判定・pathname ヘッダ) は **後続スライス (強制ゲート、既定 OFF)** で
 * 本モジュールに追加する。本スライス (enrollment) は対象ロール判定と enrollment パスのみを提供する。
 */

/**
 * MFA enrollment / 強制の対象ロール = **teacher 以上** (teacher / school_admin / system_admin)。
 *
 * NFR03「teacher 以上は MFA 強制」と一致する。生徒 (student) / 保護者 (guardian) は対象外
 * (生徒は magic-link 匿名アクセス = IdP アカウントを持たない、ADR-016)。`ADMIN_ROLES` (lib/nav.ts) と
 * 同一集合だが、意味が異なる (あちらは管理エリア可視性、こちらは MFA 対象) ため別宣言の単一ソースにする。
 *
 * `satisfies readonly TenantRole[]` で DB の役割型とズレないことをコンパイル時に担保する (ルール3)。
 */
export const MFA_REQUIRED_ROLES = [
  "system_admin",
  "school_admin",
  "teacher",
] as const satisfies readonly TenantRole[];

const MFA_REQUIRED_ROLE_SET = new Set<string>(MFA_REQUIRED_ROLES);

/** role が MFA 対象 (teacher 以上) か (純粋判定)。 */
export function isMfaRequiredRole(role: TenantRole): boolean {
  return MFA_REQUIRED_ROLE_SET.has(role);
}

/** MFA enrollment ページのパス (誘導先 / nav リンクの単一ソース)。 */
export const MFA_ENROLLMENT_PATH = "/admin/account/mfa";
