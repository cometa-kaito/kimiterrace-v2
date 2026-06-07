"use client";
import { signInWithEmailAndPassword } from "firebase/auth";
import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, useState } from "react";
import { getClientAuth } from "../../../lib/auth/clientApp";

/**
 * ログインフォーム（ADR-003 / ADR-032）。**Client Component**。
 *
 * 教員ロールが最多のため **教員ログインを既定**（先頭表示）にする（ユーザー要望）。教員は学校共通
 * パスワードのみ（必要なら学校選択）で `POST /api/auth/teacher-login` → サーバーが session cookie を発行。
 * 職員・管理者は従来の email + password（Identity Platform client SDK → `/api/auth/session`）。
 *
 * 学校が 1 校のみ共通ログイン有効なら学校選択は出さず「パスワードのみ」。複数校なら選択を出す。
 * 共通ログイン有効校が 0 なら教員モードは出さず職員ログインを既定にする。
 */
type SchoolOption = { id: string; name: string };
type Mode = "teacher" | "staff";

export function LoginForm({
  next,
  teacherSchools,
}: {
  next: string;
  teacherSchools: SchoolOption[];
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  // open-redirect 防止: 同一オリジン相対パスのみ許可（サーバーからも渡すが client 側でも再検証）。
  const rawNext = searchParams.get("next");
  const safeNext = rawNext && /^\/(?![/\\])/.test(rawNext) ? rawNext : next;

  const teacherAvailable = teacherSchools.length > 0;
  const [mode, setMode] = useState<Mode>(teacherAvailable ? "teacher" : "staff");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 教員モード
  const [schoolId, setSchoolId] = useState<string>(
    teacherSchools.length === 1 ? (teacherSchools[0]?.id ?? "") : "",
  );
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
        body: JSON.stringify({
          password: teacherPassword,
          ...(schoolId ? { schoolId } : {}),
        }),
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
        if (body.error === "select_required") {
          setError("学校を選択してください。");
        } else if (body.error === "missing_password") {
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
              {teacherSchools.length > 1 ? (
                <label className="login-field">
                  学校
                  <select
                    className="login-input"
                    value={schoolId}
                    onChange={(e) => setSchoolId(e.target.value)}
                    required
                  >
                    <option value="">学校を選択してください</option>
                    {teacherSchools.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
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
            {teacherAvailable ? (
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
