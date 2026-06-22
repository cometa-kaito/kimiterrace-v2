/**
 * Identity Platform REST `signInWithPassword` の薄いラッパ（ADR-003 / ADR-032）。**サーバー専用**。
 *
 * email + password でサインインして **idToken** を得る。idToken は呼出側が `createSessionCookie` に渡して
 * `__session` cookie 化する（通常ログインと同一経路 = 本物のセッション。RLS の school スコープが効く）。
 * `createCustomToken`（signBlob 権限が要る）は使わないため追加 IAM 不要（ADR-032 の方針）。
 *
 * 公開 API キー `NEXT_PUBLIC_FIREBASE_API_KEY`（秘密ではない）で叩く。失敗（パスワード不一致 / アカウント
 * 無効 / 設定不備 / ネットワーク）はすべて **null**（呼出側が 401/404 に写像し理由を細分化しない＝列挙対策）。
 *
 * teacher-login（共通PWログイン）と dev-login（staging 限定）の両方が同じ sign-in 経路を共有するための
 * 単一ソース。秘密値（password / idToken）は例外メッセージ・ログに出さない（ルール5）。
 */
export async function signInWithEmailPassword(
  email: string,
  password: string,
): Promise<string | null> {
  const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
  if (!apiKey) {
    return null;
  }
  let res: Response;
  try {
    res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password, returnSecureToken: true }),
      },
    );
  } catch {
    return null;
  }
  if (!res.ok) {
    return null;
  }
  const json = (await res.json().catch(() => null)) as { idToken?: unknown } | null;
  return json && typeof json.idToken === "string" && json.idToken.length > 0 ? json.idToken : null;
}
