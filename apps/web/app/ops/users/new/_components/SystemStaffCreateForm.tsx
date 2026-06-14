"use client";

import {
  type StaffCreateFieldErrors,
  collectStaffCreateFieldErrors,
} from "@/lib/role-management/staff-create-core";
import { createSystemStaffAction } from "@/lib/system-admin/users-actions";
import { FormField } from "@kimiterrace/ui";
import { type FormEvent, useState, useTransition } from "react";

/**
 * F11 (#508): system_admin が **任意校に学校管理者を発行**するフォーム。**Client Component** —
 * `createSystemStaffAction` を呼ぶ。`/admin/school/members/new` の `StaffCreateForm` (school_admin 自校版)
 * の system_admin 全校横断版で、**発行先の学校**を入力で選べる点が異なる。教員は学校共通PW (ADR-032・系統A)
 * でログインし個別アカウントを持たないため発行対象でない (教員アカウント概念の撤去・2026-06-10)。
 *
 * 認可・検証・対象校実在確認・IdP 作成・DB mirror・監査・RLS は Server Action 側 (users-actions.ts) が
 * 担保するので、ここは入力収集と **初回パスワード設定リンク (setupLink) の表示**に徹する。成功時は一覧へ
 * 戻さず setupLink を画面に出して発行者がコピー → 利用者へ共有できるようにする (email 自動送信は持たない
 * MVP、リンクは発行者経由で渡す。StaffCreateForm と同方針)。
 *
 * **項目別インライン検証 (FormField)**: email/displayName は `staff-create-core` の単一ソース検証、学校は
 * 未選択を弾く。`noValidate` でネイティブバブルと二重化しない。
 */

type SchoolOption = { id: string; name: string; prefecture: string };

/** 項目別エラー (email/displayName は core 由来 + 学校選択)。 */
type SystemStaffFieldErrors = StaffCreateFieldErrors & { schoolId?: string };

export function SystemStaffCreateForm({ schools }: { schools: SchoolOption[] }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ setupLink: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<SystemStaffFieldErrors>({});

  // 入力中はその項目のエラーを消す (修正に追従)。
  function clearError(field: keyof SystemStaffFieldErrors) {
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
    // クライアント側の項目別検証 (email/displayName は Server Action と同じ規則、学校は未選択を弾く)。
    const errors: SystemStaffFieldErrors = { ...collectStaffCreateFieldErrors(raw) };
    const schoolId = fd.get("schoolId");
    if (typeof schoolId !== "string" || schoolId === "") {
      errors.schoolId = "発行先の学校を選択してください。";
    }
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      setError(null);
      return;
    }
    setFieldErrors({});
    setError(null);
    startTransition(async () => {
      const res = await createSystemStaffAction({ ...raw, schoolId });
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

  // 学校が 1 校も無ければ発行できない (発行先が選べない)。先に学校登録へ誘導する。
  if (schools.length === 0) {
    return (
      <output style={errorStyle}>
        発行先の学校がありません。先に
        <a href="/ops/schools/new" style={{ color: "#1d4ed8" }}>
          学校を登録
        </a>
        してください。
      </output>
    );
  }

  // 成功表示: 発行済アカウントの初回設定リンクを提示する。
  if (created) {
    return (
      <div style={{ display: "grid", gap: "1rem" }}>
        <output style={successStyle}>
          アカウントを発行しました。下記の「初回パスワード設定リンク」を本人へ共有してください
          （リンクからパスワードを設定するとログインできます）。
        </output>
        <label style={labelStyle}>
          初回パスワード設定リンク
          {/* 包む label がラベル付けするため aria-label は冗長 (SR 二重読み防止)。 */}
          <input readOnly value={created.setupLink} style={inputStyle} />
        </label>
        <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
          <button type="button" onClick={copyLink} style={btnStyle}>
            {copied ? "コピーしました" : "リンクをコピー"}
          </button>
          <a href="/ops/users" style={cancelStyle}>
            一覧へ戻る
          </a>
        </div>
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

      <FormField label="学校" required error={fieldErrors.schoolId}>
        <select
          name="schoolId"
          required
          defaultValue=""
          style={inputStyle}
          onChange={() => clearError("schoolId")}
        >
          <option value="" disabled>
            学校を選択
          </option>
          {schools.map((s) => (
            <option key={s.id} value={s.id}>
              {s.prefecture} / {s.name}
            </option>
          ))}
        </select>
      </FormField>

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

      <p style={noteStyle}>発行後に表示される初回設定リンクを本人へ共有してください。</p>

      <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
        <button type="submit" disabled={pending} style={btnStyle}>
          {pending ? "発行中…" : "発行する"}
        </button>
        <a href="/ops/users" style={cancelStyle}>
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
const noteStyle: React.CSSProperties = { fontSize: "0.8rem", color: "#6b7280", margin: 0 };
