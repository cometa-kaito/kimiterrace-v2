import { requireRole } from "@/lib/auth/guard";
import { MFA_REQUIRED_ROLES } from "@/lib/mfa/policy";
import { MfaEnrollment } from "./_components/MfaEnrollment";

/**
 * F11 (#47, ADR-031): **自分の MFA (二要素認証) 登録ページ** (`/app/account/mfa`)。**Server Component**。
 *
 * **認可**: `requireRole(MFA_REQUIRED_ROLES)` で **teacher 以上** (system_admin / school_admin / teacher)
 * に限定。生徒 (student) / 保護者 (guardian) は対象外で `/forbidden` へ redirect (生徒は IdP アカウントを
 * 持たない magic-link 匿名アクセス、ADR-016 / NFR03)。
 *
 * **PoC 非強制 (ADR-031 §2)**: 本ページはあくまで「登録できる」capability。未登録でもログインは拒否しない
 * (強制ゲートは既定 OFF、`shouldRedirectToMfaEnrollment` 参照)。本番導入ゲートで強制 ON にしたとき、
 * 未登録の teacher 以上がここへ誘導される。
 *
 * 登録 / 解除の実行は client SDK (`MfaEnrollment`)。監査は Server Action が IdP 再読の件数で記録する
 * (factor = TOTP、PII 非記録、ADR-031 / ルール4)。
 */
export default async function MfaEnrollmentPage() {
  await requireRole(MFA_REQUIRED_ROLES);

  return (
    <section style={{ maxWidth: 560 }}>
      <h1 style={titleStyle}>二要素認証 (MFA)</h1>
      <p style={subtitleStyle}>
        アカウント乗っ取りを防ぐため、authenticator アプリによる二要素認証を登録できます。
        本運用では教職員の登録が必須になります（試験運用中は任意です）。
      </p>
      <MfaEnrollment />
    </section>
  );
}

const titleStyle: React.CSSProperties = {
  fontSize: "1.3rem",
  fontWeight: 700,
  margin: "0 0 0.5rem",
};
const subtitleStyle: React.CSSProperties = { color: "#6b7280", margin: "0 0 1.25rem" };
