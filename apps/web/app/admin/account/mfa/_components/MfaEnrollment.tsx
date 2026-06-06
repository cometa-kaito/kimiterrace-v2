"use client";

import { recordMfaEnrollmentAudit } from "@/lib/mfa/enrollment-actions";
import { ConfirmDialog } from "@kimiterrace/ui";
import {
  type MultiFactorInfo,
  type TotpSecret,
  TotpMultiFactorGenerator,
  multiFactor,
} from "firebase/auth";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { getClientAuth } from "../../../../../lib/auth/clientApp";

/**
 * F11 (#47, ADR-031): 自分の **MFA (第2要素) を登録 / 解除する** Client Component。
 *
 * **factor = TOTP (authenticator アプリ)** を採用する。ADR-031 §決定 が「TOTP を既定、SMS は要否を
 * 実装時判断」とした上で、本スライスは TOTP のみで実装する。理由:
 * - **PII / コスト回避 (ルール4 / [[closed-system-security]])**: SMS は電話番号 (PII) を IdP に預け SMS
 *   送信コストも発生する。TOTP は端末内シークレットのみで電話番号を扱わず、監査にも PII が乗らない。
 * - 公立校の閉域・セキュリティ優先方針と整合し、外部 (SMS gateway) 依存を増やさない。
 *
 * 登録 / 解除の **実行は client SDK** (`multiFactor(user).enroll/unenroll`) が正規経路 (ADR-003)。成否は
 * サーバーの {@link recordMfaEnrollmentAudit} で監査する (件数は IdP 再読の authoritative 値、PII 非記録)。
 *
 * **session 前提**: client SDK の `currentUser` が必要 (同ブラウザでログイン済みなら persistence から復元)。
 * 復元できない / TOTP 登録に再認証が要る場合は再ログインを促す (deny でなく案内、UX)。
 */

/**
 * 監査記録を試み、成功なら true。**enroll/unenroll が既に成功した段で呼ぶ**ため監査の失敗は致命ではない。
 * 戻り値 `!ok` (監査が失敗を返した) だけでなく **IdP 一時障害等で `recordMfaEnrollmentAudit` が throw した
 * 場合も握り潰して false に畳む** (#544 Reviewer Low-2)。これにより呼び出し側は throw を enroll/unenroll
 * 自体の失敗 (汎用エラー) と取り違えず、「登録/解除は成功・監査のみ失敗」として案内できる。
 */
async function tryRecordMfaAudit(op: "enroll" | "unenroll"): Promise<boolean> {
  try {
    const res = await recordMfaEnrollmentAudit({ op });
    return res.ok;
  } catch {
    return false;
  }
}

export function MfaEnrollment() {
  const router = useRouter();
  const [enrolled, setEnrolled] = useState<MultiFactorInfo[] | null>(null);
  const [secret, setSecret] = useState<TotpSecret | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // 解除確認ダイアログの対象 factor (null で非表示)。window.confirm を共通 ConfirmDialog に置換。
  const [confirmFactor, setConfirmFactor] = useState<MultiFactorInfo | null>(null);

  // 現在の登録状況を client SDK から読む (currentUser が無ければ再ログイン案内)。
  const refresh = useCallback(() => {
    const user = getClientAuth().currentUser;
    if (!user) {
      setEnrolled(null);
      return;
    }
    setEnrolled([...multiFactor(user).enrolledFactors]);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // TOTP シークレットを生成し QR / secret key を表示する (再認証が要る場合あり)。
  async function onStart() {
    setError(null);
    setNotice(null);
    const user = getClientAuth().currentUser;
    if (!user) {
      setError("セッションを確認できませんでした。一度ログインし直してから登録してください。");
      return;
    }
    setBusy(true);
    try {
      const session = await multiFactor(user).getSession();
      const totpSecret = await TotpMultiFactorGenerator.generateSecret(session);
      setSecret(totpSecret);
    } catch {
      // 再認証要求 (auth/requires-recent-login) 等。詳細はログに出さない (トークン断片漏洩防止、ルール5)。
      setError(
        "登録を開始できませんでした。直前にログインし直す必要がある場合があります。再ログイン後にお試しください。",
      );
    } finally {
      setBusy(false);
    }
  }

  // authenticator が表示した 6 桁コードで enroll を確定し、成否をサーバー監査に記録する。
  async function onConfirm() {
    if (!secret) {
      return;
    }
    const user = getClientAuth().currentUser;
    if (!user) {
      setError("セッションを確認できませんでした。再ログインしてください。");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      // enroll 自体の失敗 (コード誤り・要再認証) はここで弾く。これ以降に進めば登録は成功している。
      try {
        const assertion = TotpMultiFactorGenerator.assertionForEnrollment(secret, code.trim());
        await multiFactor(user).enroll(assertion, "Authenticator アプリ");
      } catch {
        setError(
          "コードが正しくないか、登録に失敗しました。authenticator のコードを確認してください。",
        );
        return;
      }
      // 監査 (件数は IdP 再読の authoritative 値、PII 非記録)。監査の失敗 (!ok / throw) は致命ではなく、
      // 「登録は成功・監査のみ失敗」として案内し、登録失敗と取り違えない (#544 Reviewer Low-2)。
      const auditOk = await tryRecordMfaAudit("enroll");
      setSecret(null);
      setCode("");
      setNotice(
        auditOk
          ? "二要素認証を登録しました。"
          : "登録は完了しましたが監査記録に失敗しました。管理者に連絡してください。",
      );
      refresh();
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  // 既存の第2要素を解除する。確認は共通 ConfirmDialog (confirmFactor) 経由で、ここは確定後の実処理に徹する。
  // 解除後も監査に記録する。
  async function runUnenroll(factor: MultiFactorInfo) {
    const user = getClientAuth().currentUser;
    if (!user) {
      setConfirmFactor(null);
      setError("セッションを確認できませんでした。再ログインしてください。");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      // unenroll 自体の失敗 (要再認証等) はここで弾く。これ以降に進めば解除は成功している。
      try {
        await multiFactor(user).unenroll(factor);
      } catch {
        setError("解除に失敗しました。直前にログインし直す必要がある場合があります。");
        return;
      }
      // 監査の失敗 (!ok / throw) は致命ではなく、「解除は成功・監査のみ失敗」として案内し、
      // 解除失敗と取り違えない (#544 Reviewer Low-2)。
      const auditOk = await tryRecordMfaAudit("unenroll");
      setNotice(
        auditOk
          ? "二要素認証を解除しました。"
          : "解除は完了しましたが監査記録に失敗しました。管理者に連絡してください。",
      );
      refresh();
      router.refresh();
    } finally {
      // 成否いずれもダイアログを閉じ、busy を解除する (失敗はインライン error に集約)。
      setBusy(false);
      setConfirmFactor(null);
    }
  }

  // client SDK の currentUser が復元できない状態 (cookie session のみで遷移してきた / ブラウザ再読込で
  // SDK の in-memory ユーザーが失われた等)。requireRole は cookie session で通っているのでページ自体は表示
  // できるが、MFA 登録は IdP client SDK の現在ユーザー (+ 直近の再認証) を正規経路として要求する (ADR-003 /
  // ADR-031)。ここでセキュリティ強度は下げず、再ログイン導線を明示して詰まりを防ぐ (案内であって deny ではない)。
  if (enrolled === null) {
    return (
      <section style={warningCardStyle}>
        <p style={warningTextStyle}>
          二要素認証の登録には、もう一度ログインして認証を確認する必要があります。
          下のボタンからログインし直すと、この画面で続けて登録できます。
        </p>
        <Link href="/login?next=/admin/account/mfa" style={loginLinkBtnStyle}>
          ログインし直す
        </Link>
      </section>
    );
  }

  return (
    <div>
      {enrolled.length > 0 ? (
        <section style={cardStyle}>
          <h2 style={h2Style}>登録済みの二要素認証</h2>
          <ul style={listStyle}>
            {enrolled.map((f) => (
              <li key={f.uid} style={listItemStyle}>
                <span>{f.displayName || "Authenticator アプリ"}</span>
                <button
                  type="button"
                  onClick={() => setConfirmFactor(f)}
                  disabled={busy}
                  style={dangerBtnStyle}
                >
                  解除
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <p style={subtitleStyle}>まだ二要素認証を登録していません。</p>
      )}

      {secret ? (
        <section style={cardStyle}>
          <h2 style={h2Style}>authenticator アプリに登録</h2>
          <p style={subtitleStyle}>
            お使いの authenticator アプリ（Google Authenticator
            等）で以下のセットアップキーを登録し、 表示される 6 桁コードを入力してください。
          </p>
          <p style={secretKeyStyle}>セットアップキー: {secret.secretKey}</p>
          <label style={labelStyle}>
            6 桁コード
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              style={inputStyle}
            />
          </label>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy || code.trim().length === 0}
            style={primaryBtnStyle}
          >
            {busy ? "登録中…" : "登録を確定"}
          </button>
        </section>
      ) : (
        <button type="button" onClick={onStart} disabled={busy} style={primaryBtnStyle}>
          {busy ? "準備中…" : "二要素認証を登録"}
        </button>
      )}

      {error ? <output style={errorStyle}>{error}</output> : null}
      {notice ? <output style={noticeStyle}>{notice}</output> : null}

      <ConfirmDialog
        open={confirmFactor !== null}
        tone="danger"
        title="二要素認証を解除しますか？"
        description="解除すると、次回からパスワードのみでログインします。"
        confirmLabel="解除する"
        pending={busy}
        onConfirm={() => {
          if (confirmFactor) {
            runUnenroll(confirmFactor);
          }
        }}
        onCancel={() => setConfirmFactor(null)}
      />
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  border: "1px solid #e5e7eb",
  borderRadius: "8px",
  padding: "1rem",
  marginBottom: "1rem",
};
const h2Style: React.CSSProperties = { fontSize: "1rem", fontWeight: 600, margin: "0 0 0.5rem" };
const subtitleStyle: React.CSSProperties = { color: "#6b7280", margin: "0 0 0.75rem" };
const listStyle: React.CSSProperties = { listStyle: "none", padding: 0, margin: 0 };
const listItemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "0.4rem 0",
  borderBottom: "1px solid #f3f4f6",
};
const labelStyle: React.CSSProperties = { display: "block", marginBottom: "0.75rem" };
const inputStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  maxWidth: 200,
  padding: "0.4rem",
  marginTop: "0.25rem",
};
const secretKeyStyle: React.CSSProperties = {
  fontFamily: "monospace",
  background: "#f9fafb",
  padding: "0.5rem",
  borderRadius: "6px",
  wordBreak: "break-all",
};
const primaryBtnStyle: React.CSSProperties = {
  padding: "0.4rem 1rem",
  background: "#1d4ed8",
  color: "#fff",
  border: "none",
  borderRadius: "6px",
  cursor: "pointer",
};
const dangerBtnStyle: React.CSSProperties = {
  padding: "0.2rem 0.7rem",
  background: "#fff",
  color: "#b91c1c",
  border: "1px solid #fca5a5",
  borderRadius: "6px",
  fontSize: "0.8rem",
  cursor: "pointer",
};
const errorStyle: React.CSSProperties = {
  display: "block",
  color: "#b91c1c",
  marginTop: "0.75rem",
};
const noticeStyle: React.CSSProperties = {
  display: "block",
  color: "#166534",
  marginTop: "0.75rem",
};
// currentUser を復元できない時の再ログイン案内。内容 (問題報告 + 行動依頼) に合わせ成功色 (緑) でなく
// 案内/警告色 (amber) を使う。緑だと「成功」に読めて意味が逆になる。
const warningCardStyle: React.CSSProperties = {
  border: "1px solid #fcd34d",
  background: "#fffbeb",
  borderRadius: "8px",
  padding: "1rem",
};
const warningTextStyle: React.CSSProperties = {
  color: "#92400e",
  margin: "0 0 0.75rem",
};
const loginLinkBtnStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "0.4rem 1rem",
  background: "#1d4ed8",
  color: "#fff",
  borderRadius: "6px",
  textDecoration: "none",
};
