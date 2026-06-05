"use client";
import { signInWithEmailAndPassword } from "firebase/auth";
import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, Suspense, useState } from "react";
import { getClientAuth } from "../../lib/auth/clientApp";

/**
 * ログイン画面 (ADR-003)。
 *
 * Identity Platform client SDK でサインイン → ID トークンを /api/auth/session へ POST
 * → session cookie 確立 → next へ遷移、という認証の配線。
 *
 * **遷移先 next の既定は `/admin`**（ロール別ホームへサーバー側でリダイレクトされる）。
 * 旧既定 `/` は scaffold placeholder（行き止まり）だったため、ログイン後にユーザーが
 * 作業画面へ入れなかった回帰を解消する（教員 → /admin/editor 等）。
 *
 * `useSearchParams` を使う子は Suspense 境界で包む (Next.js のビルド要件)。
 */
export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // 既定は /admin（ロール別ホームへサーバーが振り分ける）。`/` は行き止まりだったため使わない。
  const next = searchParams.get("next") || "/admin";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const credential = await signInWithEmailAndPassword(getClientAuth(), email, password);
      const idToken = await credential.user.getIdToken();
      const res = await fetch("/api/auth/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idToken }),
      });
      if (!res.ok) {
        throw new Error(`session 確立に失敗しました (${res.status})`);
      }
      router.push(next);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "ログインに失敗しました");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login-screen">
      <div className="login-card">
        {/* ブランドロゴ（アイコン + キミテラス）。装飾目的のため alt は簡潔に。 */}
        <img className="login-logo" src="/brand/logo-full.png" alt="キミテラス" />
        <h1 className="login-title">ログイン</h1>
        <form onSubmit={onSubmit}>
          <label className="login-field">
            メールアドレス
            <input
              className="login-input"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label className="login-field">
            パスワード
            <input
              className="login-input"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <button
            type="submit"
            className="brand-btn"
            style={{ width: "100%", marginTop: "0.5rem" }}
            disabled={submitting}
          >
            {submitting ? "ログイン中..." : "ログイン"}
          </button>
        </form>
        {error ? <p className="login-error">{error}</p> : null}
      </div>
    </main>
  );
}
