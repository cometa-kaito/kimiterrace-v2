/**
 * Identity Platform REST `accounts:signInWithCustomToken` の薄いラッパ（ADR-003）。**サーバー専用**。
 *
 * Admin SDK `createCustomToken(uid)` で得た custom token を **idToken** に交換する（**パスワード不要**）。idToken は
 * 呼出側（session.createSessionCookieForUid）が `createSessionCookie` に渡して `__session` cookie 化する（通常
 * ログインと同一の cookie 発行経路 = 本物のセッション。RLS の school スコープが効く）。
 *
 * ## なぜ session.ts と分けるか（SEC-002 構造不変条件）
 * 公開 API キー `NEXT_PUBLIC_FIREBASE_API_KEY`（秘密ではない・クライアントへ配布される公開値）で叩く。サーバ認証
 * 判定モジュール（session.ts / guard.ts / adminApp.ts）は **NEXT_PUBLIC_ を一切参照しない**という構造監査
 * （auth-bypass-flag-audit）があるため、公開 API キーを使うこの REST 交換は password-sign-in.ts と同様に **別モジュール**
 * へ切り出す。`signInWithPassword` 版（password-sign-in.ts）と対になる「custom token 版」の単一ソース。
 *
 * 失敗（API キー欠如 / HTTP 失敗 / idToken 欠落）はすべて throw する。呼出側（createSessionCookieForUid）が伝播し、
 * dev-login route が握り潰して 404 化する（ルート存在秘匿・列挙対策）。秘密値・トークン断片は例外メッセージ・ログに
 * 出さない（ルール5。応答本文はトークンを含みうるため出さず、ステータスのみ）。
 */
export async function exchangeCustomTokenForIdToken(customToken: string): Promise<string> {
  const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
  if (!apiKey) {
    throw new Error("custom_token_exchange_unavailable");
  }
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }),
    },
  );
  if (!res.ok) {
    // ステータスのみ（応答本文はトークン/秘密を含みうるため出さない、ルール5）。
    throw new Error(`custom_token_exchange_failed:${res.status}`);
  }
  const json = (await res.json().catch(() => null)) as { idToken?: unknown } | null;
  if (!json || typeof json.idToken !== "string" || json.idToken.length === 0) {
    throw new Error("custom_token_exchange_no_id_token");
  }
  return json.idToken;
}
