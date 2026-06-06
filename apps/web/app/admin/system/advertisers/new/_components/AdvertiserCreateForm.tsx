"use client";

import { createAdvertiserAction } from "@/lib/system-admin/advertisers-actions";
import {
  ADVERTISER_STATUS_DESCRIPTION,
  ADVERTISER_STATUS_LABEL,
  ADVERTISER_STATUS_ORDER,
  type AdvertiserFieldErrors,
  collectAdvertiserFieldErrors,
  hasAdvertiserFieldErrors,
} from "@/lib/system-admin/advertisers-core";
import { FormField } from "@kimiterrace/ui";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";

/**
 * F10 (#46): 広告主新規登録フォーム。**Client Component** — `createAdvertiserAction` を呼び、成功時は
 * 一覧へ戻る。認可・検証・監査・RLS WITH CHECK は Server Action 側が担保するので、ここは入力収集と
 * 結果表示に徹する (SchoolCreateForm と同方針)。会社名のみ必須、その他は任意。
 *
 * **項目別インライン検証 (FormField)**: 送信前に `collectAdvertiserFieldErrors` で項目別に検証し、エラーは
 * 各項目の下に表示する (会社名の必須・各項目の最大長・メール形式)。検証規則は Server Action と同じ単一
 * ソース。`noValidate` でネイティブ検証バブルと二重化しない (可視エラーは JS 検証が単一で担う)。
 */
export function AdvertiserCreateForm() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<AdvertiserFieldErrors>({});

  // 入力中はその項目のエラーを消す (修正に追従)。
  function clearError(field: keyof AdvertiserFieldErrors) {
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
    const raw = {
      companyName: fd.get("companyName"),
      industry: fd.get("industry"),
      contactEmail: fd.get("contactEmail"),
      contactPhone: fd.get("contactPhone"),
      address: fd.get("address"),
      notes: fd.get("notes"),
    };
    // クライアント側の項目別検証。エラーがあれば送信せず項目の下に表示する (Server Action と同じ規則)。
    const errors = collectAdvertiserFieldErrors(raw);
    if (hasAdvertiserFieldErrors(errors)) {
      setFieldErrors(errors);
      setError(null);
      return;
    }
    setFieldErrors({});
    setError(null);
    startTransition(async () => {
      const res = await createAdvertiserAction({ ...raw, status: fd.get("status") });
      if (res.ok) {
        router.push("/admin/system/advertisers");
        router.refresh();
      } else {
        setError(res.error.message);
      }
    });
  }

  return (
    <form onSubmit={onSubmit} noValidate style={{ display: "grid", gap: "0.5rem" }}>
      {error ? (
        <output role="alert" style={errorStyle}>
          {error}
        </output>
      ) : null}

      <FormField label="会社名" required error={fieldErrors.companyName}>
        <input
          name="companyName"
          required
          maxLength={200}
          style={inputStyle}
          onChange={() => clearError("companyName")}
        />
      </FormField>

      <FormField label="ステータス" hint="見込み / 契約中 / 休止（休止は配信対象外）">
        <select name="status" defaultValue="prospect" style={inputStyle}>
          {ADVERTISER_STATUS_ORDER.map((s) => (
            <option key={s} value={s}>
              {ADVERTISER_STATUS_LABEL[s]}（{ADVERTISER_STATUS_DESCRIPTION[s]}）
            </option>
          ))}
        </select>
      </FormField>

      <FormField label="業種" hint="任意" error={fieldErrors.industry}>
        <input
          name="industry"
          maxLength={100}
          style={inputStyle}
          onChange={() => clearError("industry")}
        />
      </FormField>

      <FormField label="担当メールアドレス" hint="任意" error={fieldErrors.contactEmail}>
        <input
          name="contactEmail"
          type="email"
          maxLength={320}
          style={inputStyle}
          onChange={() => clearError("contactEmail")}
        />
      </FormField>

      <FormField label="担当電話番号" hint="任意" error={fieldErrors.contactPhone}>
        <input
          name="contactPhone"
          maxLength={50}
          style={inputStyle}
          onChange={() => clearError("contactPhone")}
        />
      </FormField>

      <FormField label="住所" hint="任意" error={fieldErrors.address}>
        <input
          name="address"
          maxLength={1000}
          style={inputStyle}
          onChange={() => clearError("address")}
        />
      </FormField>

      <FormField label="備考" hint="任意" error={fieldErrors.notes}>
        <textarea
          name="notes"
          maxLength={2000}
          rows={3}
          style={inputStyle}
          onChange={() => clearError("notes")}
        />
      </FormField>

      <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
        <button type="submit" disabled={pending} style={btnStyle}>
          {pending ? "登録中…" : "登録する"}
        </button>
        <a href="/admin/system/advertisers" style={cancelStyle}>
          キャンセル
        </a>
      </div>
    </form>
  );
}

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
