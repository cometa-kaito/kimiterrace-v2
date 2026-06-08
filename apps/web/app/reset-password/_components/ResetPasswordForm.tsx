"use client";
import { confirmPasswordReset, verifyPasswordResetCode } from "firebase/auth";
import Link from "next/link";
import { type FormEvent, useEffect, useState } from "react";
import { getClientAuth } from "../../../lib/auth/clientApp";
import { validateNewPassword } from "../../../lib/auth/password-policy";

/**
 * パスワード設定 / リセットの client フォーム (ADR-003)。**Client Component**。
 *
 * フロー: マウント時に `oobCode` を `verifyPasswordResetCode` で検証 (対象メール取得) → 新パスワード入力 →
 * `confirmPasswordReset` で確定 → **完了画面でログイン画面への大きな導線を出す** (fix #1)。
 *
 * deny-by-default 思想: oobCode が無い / 期限切れ / 不正は「無効」画面に倒し、いずれの状態でも必ず
 * `/login` への導線を置いて利用者が詰まらないようにする (MfaEnrollment の再ログイン導線と同じ規律)。
 */
type Phase = "verifying" | "ready" | "submitting" | "done" | "invalid";

export function ResetPasswordForm({ oobCode }: { oobCode: string | null }) {
  const [phase, setPhase] = useState<Phase>("verifying");
  const [email, setEmail] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);

  // マウント時に oobCode を検証する (対象メールの取得 + 期限/有効性チェック)。
  useEffect(() => {
    if (!oobCode) {
      setPhase("invalid");
      return;
    }
    let cancelled = false;
    verifyPasswordResetCode(getClientAuth(), oobCode)
      .then((verifiedEmail) => {
        if (cancelled) return;
        setEmail(verifiedEmail);
        setPhase("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setPhase("invalid");
      });
    return () => {
      cancelled = true;
    };
  }, [oobCode]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const validation = validateNewPassword(password, confirm);
    if (!validation.ok) {
      setError(validation.message);
      return;
    }
    if (!oobCode) {
      setPhase("invalid");
      return;
    }
    setPhase("submitting");
    try {
      await confirmPasswordReset(getClientAuth(), oobCode, password);
      setPhase("done");
    } catch (e) {
      const code = (e as { code?: string } | null)?.code ?? "";
      if (code === "auth/expired-action-code" || code === "auth/invalid-action-code") {
        // 確定の段で期限切れ/不正になったら無効画面へ (再発行を案内)。
        setPhase("invalid");
        return;
      }
      if (code === "auth/weak-password") {
        setError("パスワードが弱すぎます。別のパスワードをお試しください。");
      } else {
        setError("パスワードの設定に失敗しました。時間をおいて再度お試しください。");
      }
      setPhase("ready");
    }
  }

  return (
    <main className="login-screen">
      <div className="login-card">
        <img className="login-logo" src="/brand/logo-full.png" alt="キミテラス" />

        {phase === "verifying" ? (
          <p className="login-title" style={{ fontSize: "1rem" }}>
            リンクを確認しています…
          </p>
        ) : null}

        {phase === "invalid" ? (
          <>
            <h1 className="login-title">リンクが無効です</h1>
            <p style={mutedStyle}>
              このパスワード設定リンクは期限切れか、すでに使用済みです。お手数ですが、新しいリンクの発行を
              管理者にご依頼ください。
            </p>
            <Link href="/login" className="brand-btn" style={blockBtnStyle}>
              ログイン画面へ
            </Link>
          </>
        ) : null}

        {phase === "done" ? (
          <>
            <h1 className="login-title">パスワードを設定しました</h1>
            <p style={mutedStyle}>
              新しいパスワードでログインできます。
              {email ? `（${email}）` : null}
            </p>
            <Link href="/login" className="brand-btn" style={blockBtnStyle}>
              ログイン画面へ
            </Link>
          </>
        ) : null}

        {phase === "ready" || phase === "submitting" ? (
          <>
            <h1 className="login-title">パスワードの設定</h1>
            {email ? <p style={mutedStyle}>{email} の新しいパスワードを設定します。</p> : null}
            <form onSubmit={onSubmit}>
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
                style={{ width: "100%", marginTop: "0.5rem" }}
                disabled={phase === "submitting"}
              >
                {phase === "submitting" ? "設定中…" : "パスワードを設定"}
              </button>
            </form>
            <p className="login-switch">
              <Link href="/login" className="login-link-btn">
                ログイン画面へ戻る
              </Link>
            </p>
          </>
        ) : null}

        {error ? (
          <p className="login-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </main>
  );
}

const mutedStyle: React.CSSProperties = {
  color: "var(--brand-muted)",
  fontSize: "0.9rem",
  margin: "0 0 1rem",
  lineHeight: 1.6,
};

// ログイン導線ボタン: brand-btn を block 幅で出し、Link でも中央寄せの押下対象にする。
const blockBtnStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "center",
  textDecoration: "none",
  marginTop: "0.5rem",
};
