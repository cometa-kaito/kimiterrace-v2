import type { TenantRole } from "@kimiterrace/db";

/**
 * F11 (#47, ADR-031): MFA capability の **純粋ロジック・型・定数**。
 *
 * **副作用なし** (cookie / DB / firebase を持ち込まない)。env フラグの解釈・強制ゲートの判定を純関数で
 * 表現し、node 環境の unit テストで網羅検証できるようにする (`lib/nav.ts` と同方針)。エンフォースの
 * 単一ソースは IdP (ADR-031 §4 / ADR-026)。本モジュールは「**いつ enrollment へ誘導するか**」の判定だけを
 * 担い、登録の真実 (enrolledFactors) は `lib/auth/mfa-admin.ts` が IdP から読む。
 *
 * **型の単一ソース (ルール3)**: role 型は `@kimiterrace/db` の `TenantRole` を型のみ import する
 * (ビルド時に消去、Next バンドルにランタイム値を引き込まない)。
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

/**
 * **MFA 強制エンフォースが有効か** を env フラグから読む。**既定 OFF (PoC 非強制、ADR-031 §2)**。
 *
 * `MFA_ENFORCEMENT` が **厳密に `"on"`** のときだけ true を返す (大小無視のため小文字化して比較)。
 * 未設定・空・`"off"`・その他の値はすべて false (fail-safe に「強制しない」へ倒す = 既存ログイン挙動を
 * 維持し、設定ミスで全教職員を突然ブロックする事故を防ぐ)。本番導入ゲートで `MFA_ENFORCEMENT=on` に
 * 切り替えて初めて強制が効く (Terraform 側 `mfa_state=ENABLED` = PR #541 と対で、IdP が単一ソース)。
 *
 * **これは秘密ではない** (feature flag、ルール5 の対象外) ため通常の env で渡してよい。
 *
 * @param env 解決対象の環境変数マップ (テスト容易性のため注入可。既定は `process.env`)。
 *   `Record<string, string | undefined>` に緩めて受け、テストから部分マップを渡せるようにする
 *   (`NodeJS.ProcessEnv` は `NODE_ENV` 必須でテスト注入が煩雑になるため)。
 */
export function isMfaEnforcementEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.MFA_ENFORCEMENT?.trim().toLowerCase() === "on";
}

/**
 * **ログイン後に MFA enrollment へ誘導すべきか** の純粋判定 (強制ゲートの中核)。
 *
 * 真になる条件は **すべて**満たすとき:
 * 1. 強制が有効 (`enforced` = `isMfaEnforcementEnabled()` の結果)。**既定 OFF なので通常は false**。
 * 2. 対象ロール (teacher 以上)。
 * 3. 登録済み第2要素が 0 件 (未登録)。
 *
 * **既定 OFF (enforced=false) のとき常に false** = enrollment ページや保護機能へ誘導せず、PoC の
 * 「未登録でもログイン可」を保つ (既存ログイン挙動の不変、回帰なし)。強制 ON 時のみ未登録の
 * teacher 以上を誘導対象にする (ADR-031 §3)。
 *
 * @param role          認証済みユーザーのロール。
 * @param enrolledFactorCount IdP が返す登録済み第2要素の件数 (`getEnrolledMfaFactorCount`)。
 * @param enforced      強制が有効か (`isMfaEnforcementEnabled()` の結果を注入)。
 */
export function shouldRedirectToMfaEnrollment(
  role: TenantRole,
  enrolledFactorCount: number,
  enforced: boolean,
): boolean {
  if (!enforced) {
    return false;
  }
  if (!isMfaRequiredRole(role)) {
    return false;
  }
  return enrolledFactorCount <= 0;
}

/** MFA enrollment ページのパス (誘導先 / nav リンクの単一ソース)。 */
export const MFA_ENROLLMENT_PATH = "/app/account/mfa";

/**
 * 現在パスを middleware → 下流 Server Component (layout) に渡すためのリクエストヘッダ名。
 * Server Component から pathname を直接読む安定 API が無いため middleware で注入する。MFA 強制ゲートの
 * **ループ防止** に使う (enrollment ページ配下では誘導しない)。pure な定数として policy に置き、
 * middleware (Edge) と layout (Node) が同じ値を共有する単一ソースにする (相互 import を避ける)。
 */
export const PATHNAME_HEADER = "x-kt-pathname";
