"use client";

import { createStaffAction } from "@/lib/role-management/member-actions";
import { type FormEvent, useState, useTransition } from "react";

/**
 * F11 (#508): 新規 teacher 発行フォーム。**Client Component** — `createStaffAction` を呼ぶ。
 *
 * 認可・検証・IdP 作成・DB mirror・監査・RLS は Server Action 側が担保するので、ここは入力収集と
 * **初回パスワード設定リンク (setupLink) の表示**に徹する (AdvertiserCreateForm と同方針)。
 * 成功時は一覧へ戻さず、setupLink を画面に出して発行者がコピー → 利用者へ共有できるようにする
 * (email 自動送信は持たない MVP、リンクは発行者経由で渡す)。
 */
export function StaffCreateForm() {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ setupLink: string } | null>(null);
  const [copied, setCopied] = useState(false);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setError(null);
    startTransition(async () => {
      const res = await createStaffAction({
        email: fd.get("email"),
        displayName: fd.get("displayName"),
      });
      if (res.ok) {
        setCreated({ setupLink: res.data.setupLink });
      } else {
        setError(res.error.message);
      }
    });
  }

  async function copyLink() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.setupLink);
      setCopied(true);
    } catch {
      // clipboard 不可環境では readonly 入力からの手動選択にフォールバック (下記 input)。
      setCopied(false);
    }
  }

  // 成功表示: 発行済アカウントの初回設定リンクを提示する。
  if (created) {
    return (
      <div style={{ display: "grid", gap: "1rem" }}>
        <output style={successStyle}>
          教員アカウントを発行しました。下記の「初回パスワード設定リンク」を本人へ共有してください
          （リンクからパスワードを設定するとログインできます）。
        </output>
        <label style={labelStyle}>
          初回パスワード設定リンク
          {/* 包む label がラベル付けするため aria-label は冗長 (SR 二重読み防止、#515 Low-1)。 */}
          <input readOnly value={created.setupLink} style={inputStyle} />
        </label>
        <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
          <button type="button" onClick={copyLink} style={btnStyle}>
            {copied ? "コピーしました" : "リンクをコピー"}
          </button>
          <a href="/admin/school/members" style={cancelStyle}>
            一覧へ戻る
          </a>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} style={{ display: "grid", gap: "1rem" }}>
      {error ? <output style={errorStyle}>{error}</output> : null}

      <label style={labelStyle}>
        メールアドレス（必須）
        <input name="email" type="email" required maxLength={320} style={inputStyle} />
      </label>

      <label style={labelStyle}>
        表示名（必須）
        <input name="displayName" required maxLength={100} style={inputStyle} />
      </label>

      <p style={noteStyle}>
        発行できるのは<strong>教員</strong>
        アカウントのみです。発行後に表示される初回設定リンクを本人へ共有してください。
      </p>

      <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
        <button type="submit" disabled={pending} style={btnStyle}>
          {pending ? "発行中…" : "発行する"}
        </button>
        <a href="/admin/school/members" style={cancelStyle}>
          キャンセル
        </a>
      </div>
    </form>
  );
}

const labelStyle: React.CSSProperties = {
  display: "grid",
  gap: "0.3rem",
  fontSize: "0.85rem",
  color: "#374151",
};
const inputStyle: React.CSSProperties = {
  padding: "0.5rem 0.6rem",
  border: "1px solid #d1d5db",
  borderRadius: "6px",
  fontSize: "0.95rem",
  fontFamily: "inherit",
};
const btnStyle: React.CSSProperties = {
  padding: "0.5rem 1.1rem",
  background: "#1d4ed8",
  color: "#fff",
  border: "none",
  borderRadius: "6px",
  fontSize: "0.9rem",
  cursor: "pointer",
};
const cancelStyle: React.CSSProperties = { fontSize: "0.85rem", color: "#6b7280" };
const errorStyle: React.CSSProperties = { display: "block", color: "#b91c1c", fontSize: "0.85rem" };
const successStyle: React.CSSProperties = {
  display: "block",
  color: "#065f46",
  fontSize: "0.9rem",
};
const noteStyle: React.CSSProperties = { fontSize: "0.8rem", color: "#6b7280", margin: 0 };
