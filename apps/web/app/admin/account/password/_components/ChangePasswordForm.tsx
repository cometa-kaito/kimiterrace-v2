"use client";
import { signInWithEmailAndPassword, updatePassword } from "firebase/auth";
import Link from "next/link";
import { type FormEvent, useState } from "react";
import { getClientAuth } from "../../../../../lib/auth/clientApp";
import { validateNewPassword } from "../../../../../lib/auth/password-policy";

/**
 * ログイン後のパスワード変更 client フォーム (ADR-003)。**Client Component**。
 *
 * **再認証は `signInWithEmailAndPassword` で行う** (現在のパスワードを使い直接サインインし直す)。client SDK の
 * `currentUser` は cookie session 経由の遷移や再読込で失われうる ([[feedback_react19...]] と同系の MFA で実踏:
 * MfaEnrollment は currentUser 喪失時に再ログイン導線を出す) ため、`currentUser` に依存せず確実に user 資格を
 * 得てから `updatePassword` する。これにより「最近の再認証が必要 (auth/requires-recent-login)」も回避できる。
 *
 * email が session から取得できない場合は変更不能なので、再ログイン導線を出して詰みを防ぐ。
 */
export function ChangePasswordForm({ email }: { email: string | null }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (!email) {
    // email 不明 (claim 欠落 / 再読込で session のみ) では再認証できない → 再ログインへ誘導。
    return (
      <p className="login-error" role="alert">
        メールアドレスが取得できませんでした。
        <Link href="/login?next=/admin/account/password" style={{ marginLeft: "0.4rem" }}>
          ログインし直す
        </Link>
      </p>
    );
  }
  // ここで email は string に narrowing 済。const に束ねて onSubmit クロージャでも cast なしで使う (ルール3)。
  const verifiedEmail: string = email;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const validation = validateNewPassword(password, confirm);
    if (!validation.ok) {
      setError(validation.message);
      return;
    }
    setSubmitting(true);
    try {
      // 現在のパスワードで再認証 (currentUser に依存しない確実な資格取得)。verifiedEmail は guard 後の string。
      const credential = await signInWithEmailAndPassword(
        getClientAuth(),
        verifiedEmail,
        currentPassword,
      );
      await updatePassword(credential.user, password);
      setDone(true);
      setCurrentPassword("");
      setPassword("");
      setConfirm("");
    } catch (e) {
      const code = (e as { code?: string } | null)?.code ?? "";
      if (
        code === "auth/wrong-password" ||
        code === "auth/invalid-credential" ||
        code === "auth/invalid-login-credentials"
      ) {
        setError("現在のパスワードが正しくありません。");
      } else if (code === "auth/too-many-requests") {
        setError("試行回数が多すぎます。しばらく時間をおいてからお試しください。");
      } else if (code === "auth/weak-password") {
        setError("パスワードが弱すぎます。別のパスワードをお試しください。");
      } else if (code === "auth/multi-factor-auth-required") {
        setError("二要素認証が必要です。ログイン画面からやり直してください。");
      } else {
        setError("パスワードの変更に失敗しました。時間をおいて再度お試しください。");
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <p style={{ color: "var(--brand-fg)" }} role="status">
        パスワードを変更しました。次回のログインから新しいパスワードをお使いください。
      </p>
    );
  }

  return (
    <form onSubmit={onSubmit}>
      <label className="login-field">
        現在のパスワード
        <input
          className="login-input"
          type="password"
          autoComplete="current-password"
          required
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
        />
      </label>
      <label className="login-field">
        新しいパスワード
        <input
          className="login-input"
          type="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      <label className="login-field">
        新しいパスワード（確認）
        <input
          className="login-input"
          type="password"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
      </label>
      <button
        type="submit"
        className="brand-btn"
        style={{ marginTop: "0.5rem" }}
        disabled={submitting}
      >
        {submitting ? "変更中…" : "パスワードを変更"}
      </button>
      {error ? (
        <p className="login-error" role="alert" style={{ marginTop: "0.75rem" }}>
          {error}
        </p>
      ) : null}
    </form>
  );
}
