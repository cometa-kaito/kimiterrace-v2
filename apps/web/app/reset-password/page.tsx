import { ResetPasswordForm } from "./_components/ResetPasswordForm";

/**
 * パスワード設定 / リセットの **自前 action ページ** (`/reset-password?oobCode=...`)。**公開ルート**
 * (middleware の matcher で除外済み)。発行された設定リンク (admin-mutations の `buildInAppResetLink`) や
 * 既定の Firebase ハンドラに代わってここで完結させ、完了後に **ログイン画面への明確な導線**を出す。
 *
 * `oobCode` は server で searchParams から取り出して client へ渡す (useSearchParams + Suspense を避ける)。
 * 実際の検証 / 確定は client SDK (`verifyPasswordResetCode` / `confirmPasswordReset`、ResetPasswordForm)。
 */
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ oobCode?: string | string[] }>;
}) {
  const params = await searchParams;
  const raw = params.oobCode;
  const oobCode = Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null);
  return <ResetPasswordForm oobCode={oobCode} />;
}
