/**
 * 初回パスワード設定 / リセットリンクを **自前の in-app リセットページ** (`/reset-password`) に
 * 向けて組み立てる純ロジック (副作用なし・node で unit テスト可)。
 *
 * Identity Platform の `generatePasswordResetLink` は既定で Firebase ホストの action ハンドラ
 * (`https://<project>.firebaseapp.com/__/auth/action?mode=resetPassword&oobCode=...`) を返す。この既定
 * ページは英語の「Password changed」表示で **ログイン画面への導線が無い** ため、`oobCode` だけを取り出して
 * 自前ページ (`{origin}/reset-password?oobCode=...`) に載せ替える。`oobCode` は同一プロジェクトの client SDK
 * (`confirmPasswordReset`) でそのまま消費できる (apiKey は NEXT_PUBLIC config 由来で別途持つため不要)。
 *
 * **フォールバック**: `oobCode` を抽出できない / `origin` が空なら **既定リンクをそのまま返す** (発行を
 * 壊さない = 安全側)。これにより origin 解決に失敗してもアカウント発行自体は成功する。
 */

/** Firebase の reset リンク URL から `oobCode` クエリを取り出す。解析不能 / 不在は null。 */
export function extractOobCode(firebaseResetLink: string): string | null {
  try {
    return new URL(firebaseResetLink).searchParams.get("oobCode");
  } catch {
    return null;
  }
}

/**
 * Firebase の reset リンクを自前ページ `{origin}/reset-password?oobCode=...` に載せ替える。
 * `oobCode` 抽出不能 / `appOrigin` 空のときは元リンクをそのまま返す (発行を壊さない)。
 */
export function buildInAppResetLink(firebaseResetLink: string, appOrigin: string): string {
  const oobCode = extractOobCode(firebaseResetLink);
  if (!oobCode || !appOrigin) {
    return firebaseResetLink;
  }
  // origin 末尾スラッシュを正規化して二重 `//` を避ける。
  const origin = appOrigin.replace(/\/+$/, "");
  return `${origin}/reset-password?oobCode=${encodeURIComponent(oobCode)}`;
}
