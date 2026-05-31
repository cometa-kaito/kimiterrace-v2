"use client";

import { updateAdvertiserAction } from "@/lib/system-admin/advertisers-actions";
import type { AdvertiserDetail } from "@/lib/system-admin/advertisers-queries";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";

/**
 * F10 (#46): 広告主編集フォーム。**Client Component** — 現在値を初期表示し `updateAdvertiserAction` を
 * 呼ぶ。成功時は一覧へ戻る。認可・検証・監査・RLS は Server Action 側が担保するので、ここは入力収集と
 * 結果表示に徹する (AdvertiserCreateForm と同方針)。会社名のみ必須、その他は任意。稼働状態の切替は
 * 一覧の稼働トグルが管轄で本フォームには含めない。
 */
export function AdvertiserEditForm({ advertiser }: { advertiser: AdvertiserDetail }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setError(null);
    startTransition(async () => {
      const res = await updateAdvertiserAction(advertiser.id, {
        companyName: fd.get("companyName"),
        industry: fd.get("industry"),
        contactEmail: fd.get("contactEmail"),
        contactPhone: fd.get("contactPhone"),
        address: fd.get("address"),
        notes: fd.get("notes"),
      });
      if (res.ok) {
        router.push("/admin/system/advertisers");
        router.refresh();
      } else {
        setError(res.error.message);
      }
    });
  }

  return (
    <form onSubmit={onSubmit} style={{ display: "grid", gap: "1rem" }}>
      {error ? <output style={errorStyle}>{error}</output> : null}

      <label style={labelStyle}>
        会社名（必須）
        <input
          name="companyName"
          required
          maxLength={200}
          defaultValue={advertiser.companyName}
          style={inputStyle}
        />
      </label>

      <label style={labelStyle}>
        業種（任意）
        <input
          name="industry"
          maxLength={100}
          defaultValue={advertiser.industry ?? ""}
          style={inputStyle}
        />
      </label>

      <label style={labelStyle}>
        担当メールアドレス（任意）
        <input
          name="contactEmail"
          type="email"
          maxLength={320}
          defaultValue={advertiser.contactEmail ?? ""}
          style={inputStyle}
        />
      </label>

      <label style={labelStyle}>
        担当電話番号（任意）
        <input
          name="contactPhone"
          maxLength={50}
          defaultValue={advertiser.contactPhone ?? ""}
          style={inputStyle}
        />
      </label>

      <label style={labelStyle}>
        住所（任意）
        <input
          name="address"
          maxLength={1000}
          defaultValue={advertiser.address ?? ""}
          style={inputStyle}
        />
      </label>

      <label style={labelStyle}>
        備考（任意）
        <textarea
          name="notes"
          maxLength={2000}
          rows={3}
          defaultValue={advertiser.notes ?? ""}
          style={inputStyle}
        />
      </label>

      <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
        <button type="submit" disabled={pending} style={btnStyle}>
          {pending ? "保存中…" : "保存する"}
        </button>
        <a href="/admin/system/advertisers" style={cancelStyle}>
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
