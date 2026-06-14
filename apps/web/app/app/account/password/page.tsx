import { requireRole } from "@/lib/auth/guard";
import { PASSWORD_CHANGE_ROLES } from "@/lib/auth/password-policy";
import { ChangePasswordForm } from "./_components/ChangePasswordForm";

/**
 * ログイン後の **自分のパスワード変更ページ** (`/app/account/password`)。**Server Component**。
 *
 * **認可**: `requireRole(PASSWORD_CHANGE_ROLES)` で **system_admin / school_admin** に限定。teacher は
 * 学校共通パスワード (ADR-032) でログインし個人 PW を持たない (共通アカウントを変えると学校全体に波及する)
 * ため対象外で `/forbidden` へ。実変更は client SDK (`signInWithEmailAndPassword` で再認証 → `updatePassword`、
 * ChangePasswordForm)。対象メールは session の claim から取得して client に渡す。
 */
export default async function ChangePasswordPage() {
  const user = await requireRole(PASSWORD_CHANGE_ROLES);

  return (
    <section style={{ maxWidth: 480 }}>
      <h1 style={titleStyle}>パスワード変更</h1>
      <p style={subtitleStyle}>
        ログイン中のアカウントのパスワードを変更します。安全のため、現在のパスワードの再入力が必要です。
      </p>
      <ChangePasswordForm email={user.email ?? null} />
    </section>
  );
}

const titleStyle: React.CSSProperties = {
  fontSize: "1.3rem",
  fontWeight: 700,
  margin: "0 0 0.5rem",
};
const subtitleStyle: React.CSSProperties = {
  color: "var(--brand-muted)",
  margin: "0 0 1.25rem",
  lineHeight: 1.6,
};
