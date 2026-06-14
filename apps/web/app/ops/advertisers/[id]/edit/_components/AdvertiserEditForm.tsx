"use client";

import { updateAdvertiserAction } from "@/lib/system-admin/advertisers-actions";
import {
  ADVERTISER_DELIVERY_LABEL,
  ADVERTISER_DELIVERY_ORDER,
  companyNameError,
  toDeliveryStatus,
} from "@/lib/system-admin/advertisers-core";
import type { AdvertiserDetail } from "@/lib/system-admin/advertisers-queries";
import { FormField } from "@kimiterrace/ui";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";

/**
 * F10 (#46) / 実装設計書 §4「advertisers/[id]/edit 最小縮退」: 広告主編集フォーム。**Client Component**。
 *
 * 商流SoR一元化により業種・担当連絡先・住所・備考は **portal が正**のため v2 の編集面から外し、本フォームは
 * **表示名 (会社名) と配信ステータス (稼働中 / 休止) の 2 項目のみ**を扱う。配信ステータスは緊急停止スイッチ
 * (休止=配信対象外) で、バグ「休止が配信に反映されない」の修正対象箇所のため**死守**する。認可・検証・監査・
 * RLS・不変条件 (status⟺is_active) は Server Action 側が担保するので、ここは入力収集と結果表示に徹する。
 *
 * **項目別インライン検証 (FormField)**: 送信前に会社名を `companyNameError` で検証し (Server Action と同じ規則)、
 * エラーは項目の下に表示する。配信ステータスは select 既定ありで不正値が来ないため対象外。`noValidate` で
 * ネイティブ検証バブルと二重化しない。
 */
export function AdvertiserEditForm({ advertiser }: { advertiser: AdvertiserDetail }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | undefined>(undefined);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const companyName = fd.get("companyName");
    // クライアント側の会社名検証。エラーがあれば送信せず項目の下に表示する (Server Action と同じ規則)。
    const nameErr = companyNameError(companyName);
    if (nameErr) {
      setNameError(nameErr);
      setError(null);
      return;
    }
    setNameError(undefined);
    setError(null);
    startTransition(async () => {
      const res = await updateAdvertiserAction(advertiser.id, {
        companyName,
        status: fd.get("status"),
      });
      if (res.ok) {
        router.push("/ops/advertisers");
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

      <FormField label="表示名" required error={nameError}>
        <input
          name="companyName"
          required
          maxLength={200}
          defaultValue={advertiser.companyName}
          style={inputStyle}
          onChange={() => setNameError(undefined)}
        />
      </FormField>

      <FormField
        label="配信ステータス"
        hint="休止にするとサイネージ配信の対象外になります（緊急停止）。"
      >
        <select name="status" defaultValue={toDeliveryStatus(advertiser.status)} style={inputStyle}>
          {ADVERTISER_DELIVERY_ORDER.map((s) => (
            <option key={s} value={s}>
              {ADVERTISER_DELIVERY_LABEL[s]}
            </option>
          ))}
        </select>
      </FormField>

      <p style={noteStyle}>
        業種・担当連絡先・住所などの商流情報は管理ポータル（portal）で管理します。
      </p>

      <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
        <button type="submit" disabled={pending} style={btnStyle}>
          {pending ? "保存中…" : "保存する"}
        </button>
        <a href="/ops/advertisers" style={cancelStyle}>
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
const noteStyle: React.CSSProperties = { color: "#6b7280", fontSize: "0.8rem", margin: 0 };
