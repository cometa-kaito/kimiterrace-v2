"use client";

import { createCommunicationAction } from "@/lib/system-admin/communications-actions";
import {
  COMMUNICATION_CHANNELS,
  COMMUNICATION_CHANNEL_LABEL,
} from "@/lib/system-admin/communications-core";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";

/**
 * F10 (#46): コミュニケーション履歴の新規登録フォーム。**Client Component** — `createCommunicationAction`
 * を呼び、成功時は同じ広告主の履歴ページを refresh して新しい記録を一覧へ反映する。認可・検証・監査・
 * RLS WITH CHECK は Server Action 側が担保するので、ここは入力収集と結果表示に徹する (ContractCreateForm
 * と同方針)。
 *
 * `advertiserId` は親広告主のページから渡る。contractId は任意 (紐づく契約があれば UUID で指定、無ければ
 * 空欄)。添付 (Cloud Storage object 参照) の選択 UI は別スライス (本フォームでは未指定 = 空配列)。
 */
export function CommunicationCreateForm({ advertiserId }: { advertiserId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // currentTarget は async transition 後に null 化するため、フォーム参照を先に確保する。
    const form = e.currentTarget;
    const fd = new FormData(form);
    setError(null);
    startTransition(async () => {
      const res = await createCommunicationAction({
        advertiserId,
        contractId: fd.get("contractId"),
        channel: fd.get("channel"),
        occurredAt: toJstIso(fd.get("occurredAt")),
        subject: fd.get("subject"),
        bodyMd: fd.get("bodyMd"),
      });
      if (res.ok) {
        form.reset();
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
        チャネル（必須）
        <select name="channel" defaultValue="email" style={inputStyle}>
          {COMMUNICATION_CHANNELS.map((ch) => (
            <option key={ch} value={ch}>
              {COMMUNICATION_CHANNEL_LABEL[ch]}
            </option>
          ))}
        </select>
      </label>

      <label style={labelStyle}>
        発生日時（必須）
        <input name="occurredAt" type="datetime-local" required style={inputStyle} />
      </label>

      <label style={labelStyle}>
        件名（必須）
        <input name="subject" type="text" required maxLength={300} style={inputStyle} />
      </label>

      <label style={labelStyle}>
        本文（任意・Markdown）
        <textarea name="bodyMd" maxLength={20000} rows={5} style={inputStyle} />
      </label>

      <label style={labelStyle}>
        紐づく契約 ID（任意）
        <input
          name="contractId"
          type="text"
          inputMode="text"
          placeholder="契約に紐づく場合のみ UUID を入力"
          style={inputStyle}
        />
      </label>

      <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
        <button type="submit" disabled={pending} style={btnStyle}>
          {pending ? "登録中…" : "履歴を登録"}
        </button>
      </div>
    </form>
  );
}

/**
 * `datetime-local` 入力 ("YYYY-MM-DDTHH:mm") を JST (+09:00) の明示 timezone 付き ISO 8601 へ正規化する。
 * Server Action の検証は曖昧さ回避のため明示 timezone を必須にしており、ブラウザ入力 (timezone 無し) を
 * そのまま送ると弾かれるため、JST として確定させる。空値はそのまま渡し検証側の必須エラーに委ねる。
 */
function toJstIso(value: FormDataEntryValue | null): FormDataEntryValue | null {
  if (typeof value !== "string" || value === "") {
    return value;
  }
  // "YYYY-MM-DDTHH:mm" → "YYYY-MM-DDTHH:mm:00+09:00"。秒付き入力 (一部ブラウザ) はそのまま offset 付与。
  const withSeconds = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) ? `${value}:00` : value;
  return `${withSeconds}+09:00`;
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
const errorStyle: React.CSSProperties = { display: "block", color: "#b91c1c", fontSize: "0.85rem" };
