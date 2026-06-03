import { redirect } from "next/navigation";
import type { AuthUser } from "../auth/session";
import { getEnrolledMfaFactorCount } from "../auth/mfa-admin";
import {
  MFA_ENROLLMENT_PATH,
  isMfaEnforcementEnabled,
  shouldRedirectToMfaEnrollment,
} from "./policy";

/**
 * F11 (#47, ADR-031): **MFA 強制ゲート** (サーバー専用)。`/admin` レイアウトから認可後に呼ぶ。
 *
 * ## 既定 OFF = 既存ログイン挙動の不変 (回帰なし)
 * `MFA_ENFORCEMENT` が `"on"` でない限り (= 既定)、本関数は **IdP も叩かず即 return** する。よって
 * PoC / 既存環境では一切の挙動変化が無い (ADR-031 §2「PoC は任意」)。env を `on` にした本番導入ゲートで
 * 初めて、未登録の teacher 以上を enrollment へ誘導する (ADR-031 §3、エンフォースの単一ソースは IdP)。
 *
 * ## ループ防止
 * 既に enrollment ページ (またはその配下) に居るときは誘導しない (現在パスを引数で受け取り判定)。
 * これにより「未登録 → enrollment へ誘導 → enrollment ページのレイアウトが再度誘導」の無限ループを防ぐ。
 *
 * ## fail-safe
 * IdP 読取 (`getEnrolledMfaFactorCount`) が失敗した場合は **誘導せず通す** (throw を握りつぶす)。理由:
 * 認証エンフォースの主経路は IdP の MFA challenge 自体 (mfa_state=ENABLED) であり、本ゲートは UX 上の
 * 「未登録者を登録画面へ運ぶ」補助に過ぎない。IdP 一時障害でアプリ全体をロックアウトする方が危険なため、
 * ここは可用性優先で通す (登録強制の最終防衛線は IdP 側の challenge)。
 *
 * @param user        認可済み AuthUser (`requireRole(ADMIN_ROLES)` の戻り値)。
 * @param currentPath 現在のリクエストパス (ループ防止用)。取得できない場合は undefined。
 */
export async function enforceMfaGate(
  user: AuthUser,
  currentPath: string | undefined,
): Promise<void> {
  // 既定 OFF: IdP を叩く前にここで return (挙動不変・コストゼロ)。
  if (!isMfaEnforcementEnabled()) {
    return;
  }
  // enrollment ページ配下では誘導しない (ループ防止)。
  if (currentPath && currentPath.startsWith(MFA_ENROLLMENT_PATH)) {
    return;
  }

  let factorCount: number;
  try {
    factorCount = await getEnrolledMfaFactorCount(user.uid);
  } catch {
    // IdP 一時障害: 可用性優先で通す (登録強制の最終防衛線は IdP の MFA challenge)。
    return;
  }

  if (shouldRedirectToMfaEnrollment(user.role, factorCount, true)) {
    redirect(MFA_ENROLLMENT_PATH);
  }
}
