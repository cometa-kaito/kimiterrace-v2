"use client";
import { signInWithEmailAndPassword } from "firebase/auth";
import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, useState } from "react";
import { getClientAuth } from "../../../lib/auth/clientApp";

/**
 * ログインフォーム（ADR-003 / ADR-032）。**Client Component**。
 *
 * 教員ロールが最多のため **教員ログインを既定**（先頭表示）にする（ユーザー要望）。教員は学校を選ばず
 * **学校共通パスワードのみ**を入力して `POST /api/auth/teacher-login` → サーバーが入力パスワードで学校を
 * 自動判定し session cookie を発行する（ADR-032 追補：学校選択を廃止）。
 * 職員・管理者は従来の email + password（Identity Platform client SDK → `/api/auth/session`）。
 *
 * 共通ログイン有効校が 1 校以上あれば教員モードを既定表示、0 校なら教員モードは出さず職員ログインを既定にする
 * （`teacherLoginAvailable` で受け取る。学校の id/名はクライアントへ渡さない）。
 */
type Mode = "teacher" | "staff";

export function LoginForm({
  next,
  teacherLoginAvailable,
}: {
  next: string;
  teacherLoginAvailable: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  // open-redirect 防止: 同一オリジン相対パスのみ許可（サーバーからも渡すが client 側でも再検証）。
  const rawNext = searchParams.get("next");
  const safeNext = rawNext && /^\/(?![/\\])/.test(rawNext) ? rawNext : next;

  const [mode, setMode] = useState<Mode>(teacherLoginAvailable ? "teacher" : "staff");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 教員モード（学校選択なし＝パスワードのみ）
  const [teacherPassword, setTeacherPassword] = useState("");

  // 職員モード
  const [email, setEmail] = useState("");
  const [staffPassword, setStaffPassword] = useState("");

  async function onTeacherSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/auth/teacher-login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: teacherPassword }),
      });
      if (res.ok) {
        router.push(safeNext);
        router.refresh();
        return;
      }
      if (res.status === 429) {
        setError("試行回数が多すぎます。しばらく時間をおいてからお試しください。");
      } else {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (body.error === "missing_password") {
          setError("パスワードを入力してください。");
        } else {
          setError("パスワードが正しくありません。");
        }
      }
    } catch {
      setError("ログインに失敗しました。通信状態をご確認ください。");
    } finally {
      setSubmitting(false);
    }
  }

  async function onStaffSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const credential = await signInWithEmailAndPassword(getClientAuth(), email, staffPassword);
      const idToken = await credential.user.getIdToken();
      const res = await fetch("/api/auth/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idToken }),
      });
      if (!res.ok) {
        throw new Error(`session 確立に失敗しました (${res.status})`);
      }
      router.push(safeNext);
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
        <img className="login-logo" src="/brand/logo-full.png" alt="キミテラス" />

        {mode === "teacher" ? (
          <>
            <h1 className="login-title">教員ログイン</h1>
            <form onSubmit={onTeacherSubmit}>
              <label className="login-field">
                パスワード
                <input
                  className="login-input"
                  type="password"
                  inputMode="text"
                  autoComplete="current-password"
                  required
                  value={teacherPassword}
                  onChange={(e) => setTeacherPassword(e.target.value)}
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
            <p className="login-switch">
              職員・管理者の方は{" "}
              <button type="button" className="login-link-btn" onClick={() => setMode("staff")}>
                こちらからログイン
              </button>
            </p>
          </>
        ) : (
          <>
            <h1 className="login-title">職員・管理者ログイン</h1>
            <form onSubmit={onStaffSubmit}>
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
                  value={staffPassword}
                  onChange={(e) => setStaffPassword(e.target.value)}
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
            {teacherLoginAvailable ? (
              <p className="login-switch">
                教員の方は{" "}
                <button type="button" className="login-link-btn" onClick={() => setMode("teacher")}>
                  こちらからログイン
                </button>
              </p>
            ) : null}
          </>
        )}

        {error ? (
          <p className="login-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </main>
  );
}
