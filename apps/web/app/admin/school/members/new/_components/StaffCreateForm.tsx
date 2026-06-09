"use client";

import { createStaffAction } from "@/lib/role-management/member-actions";
import {
  type StaffCreateFieldErrors,
  collectStaffCreateFieldErrors,
  hasStaffCreateFieldErrors,
} from "@/lib/role-management/staff-create-core";
import { FormField } from "@kimiterrace/ui";
import { type FormEvent, useRef, useState, useTransition } from "react";

/**
 * F11 (#508): 新規 teacher 発行フォーム。**Client Component** — `createStaffAction` を呼ぶ。
 *
 * 認可・検証・IdP 作成・DB mirror・監査・RLS は Server Action 側が担保するので、ここは入力収集と
 * **初回パスワード設定リンク (setupLink) の表示**に徹する (AdvertiserCreateForm と同方針)。
 * 成功時は一覧へ戻さず、setupLink を画面に出して発行者がコピー → 利用者へ共有できるようにする
 * (email 自動送信は持たない MVP、リンクは発行者経由で渡す)。
 *
 * **項目別インライン検証 (FormField)**: 送信前に `collectStaffCreateFieldErrors` で項目別に検証し、エラーは
 * 各項目の下に表示する。検証規則は Server Action と同じ単一ソース (staff-create-core)。`noValidate` で
 * ネイティブ検証バブルと二重化しない。
 */
export function StaffCreateForm() {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ setupLink: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<StaffCreateFieldErrors>({});
  // clipboard 失敗時に readonly 入力を選択状態へ誘導するための参照。
  const linkInputRef = useRef<HTMLInputElement>(null);

  // 入力中はその項目のエラーを消す (修正に追従)。
  function clearError(field: keyof StaffCreateFieldErrors) {
    setFieldErrors((prev) => {
      if (prev[field] === undefined) {
        return prev;
      }
      const next = { ...prev };
      delete next[field];
      return next;
    });
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const raw = { email: fd.get("email"), displayName: fd.get("displayName") };
    // クライアント側の項目別検証。エラーがあれば送信せず項目の下に表示する (Server Action と同じ規則)。
    const errors = collectStaffCreateFieldErrors(raw);
    if (hasStaffCreateFieldErrors(errors)) {
      setFieldErrors(errors);
      setError(null);
      return;
    }
    setFieldErrors({});
    setError(null);
    startTransition(async () => {
      const res = await createStaffAction(raw);
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
      setCopyFailed(false);
    } catch {
      // clipboard 不可環境 (非 HTTPS / 権限拒否 / 旧ブラウザ)。従来は setCopied(false) のみで導線が無く
      // 「コピーできたのか分からない」詰まりになっていた。readonly 入力を選択状態にして手動コピーへ
      // 確実に誘導し、その旨を明示する (B2)。
      setCopied(false);
      setCopyFailed(true);
      linkInputRef.current?.focus();
      linkInputRef.current?.select();
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
        <p style={warnNoteStyle}>
          ⚠ このリンクは<strong>この画面でのみ表示</strong>
          されます。今コピーして本人へ共有してください （メール自動送信は行いません）。
        </p>
        <label style={labelStyle}>
          初回パスワード設定リンク
          {/* 包む label がラベル付けするため aria-label は冗長 (SR 二重読み防止、#515 Low-1)。 */}
          <input ref={linkInputRef} readOnly value={created.setupLink} style={inputStyle} />
        </label>
        <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
          <button type="button" onClick={copyLink} style={btnStyle}>
            {copied ? "コピーしました" : "リンクをコピー"}
          </button>
          <a href="/admin/school/members" style={cancelStyle}>
            一覧へ戻る
          </a>
        </div>
        {copyFailed ? (
          <p role="status" style={copyHintStyle}>
            自動コピーできませんでした。上のリンクが選択されています。手動でコピー（Ctrl/⌘＋C）してください。
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate style={{ display: "grid", gap: "0.5rem" }}>
      {error ? (
        <output role="alert" style={errorStyle}>
          {error}
        </output>
      ) : null}

      <FormField label="メールアドレス" required error={fieldErrors.email}>
        <input
          name="email"
          type="email"
          required
          maxLength={320}
          style={inputStyle}
          onChange={() => clearError("email")}
        />
      </FormField>

      <FormField label="表示名" required error={fieldErrors.displayName}>
        <input
          name="displayName"
          required
          maxLength={100}
          style={inputStyle}
          onChange={() => clearError("displayName")}
        />
      </FormField>

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
  display: "block",
  width: "100%",
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
const warnNoteStyle: React.CSSProperties = {
  margin: 0,
  fontSize: "0.85rem",
  color: "#92400e",
  background: "#fffbeb",
  border: "1px solid #fcd34d",
  borderRadius: "6px",
  padding: "0.5rem 0.7rem",
};
const copyHintStyle: React.CSSProperties = { margin: 0, fontSize: "0.82rem", color: "#92400e" };
const noteStyle: React.CSSProperties = { fontSize: "0.8rem", color: "#6b7280", margin: 0 };
