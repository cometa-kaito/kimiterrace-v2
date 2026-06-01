"use client";

import { createContractAction } from "@/lib/system-admin/contracts-actions";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";

/**
 * F10 (#46): 契約新規登録フォーム。**Client Component** — `createContractAction` を呼び、成功時は
 * 同じ広告主の契約ページを refresh して新しい契約を一覧へ反映する。認可・検証・監査・RLS WITH CHECK は
 * Server Action 側が担保するので、ここは入力収集と結果表示に徹する (AdvertiserCreateForm と同方針)。
 *
 * `advertiserId` は親広告主のページから渡る。配信対象校 (target_schools) の複数選択 UI は別スライス
 * (本フォームでは未指定 = 空配列)。
 */
export function ContractCreateForm({ advertiserId }: { advertiserId: string }) {
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
      const res = await createContractAction({
        advertiserId,
        status: fd.get("status"),
        startedAt: fd.get("startedAt"),
        endedAt: fd.get("endedAt"),
        monthlyFeeJpy: fd.get("monthlyFeeJpy"),
        notes: fd.get("notes"),
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
        ステータス（必須）
        <select name="status" defaultValue="draft" style={inputStyle}>
          <option value="draft">下書き</option>
          <option value="active">稼働中</option>
          <option value="paused">一時停止</option>
          <option value="terminated">終了</option>
        </select>
      </label>

      <label style={labelStyle}>
        開始日（必須）
        <input name="startedAt" type="date" required style={inputStyle} />
      </label>

      <label style={labelStyle}>
        終了日（任意・無期限なら空欄）
        <input name="endedAt" type="date" style={inputStyle} />
      </label>

      <label style={labelStyle}>
        月額（円・必須・税抜）
        <input
          name="monthlyFeeJpy"
          type="number"
          required
          min={0}
          step={1}
          inputMode="numeric"
          style={inputStyle}
        />
      </label>

      <label style={labelStyle}>
        備考（任意）
        <textarea name="notes" maxLength={2000} rows={3} style={inputStyle} />
      </label>

      <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
        <button type="submit" disabled={pending} style={btnStyle}>
          {pending ? "登録中…" : "契約を登録"}
        </button>
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
const errorStyle: React.CSSProperties = { display: "block", color: "#b91c1c", fontSize: "0.85rem" };
