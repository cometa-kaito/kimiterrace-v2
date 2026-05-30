"use client";

import type { PublishScopeValue } from "@/lib/contents/publish-core";
import { SCOPE_OPTIONS } from "@/lib/contents/publish-view";

/**
 * F04.4: 公開先明示セレクタ。
 *
 * 要件「曖昧な『全校』ボタンを設けず、明示選択させる」に従い、ラジオで全選択肢を**対等に**並べ
 * (全校を強調/既定にしない)、各選択肢に「誰に見えるか」を明記する。初期状態 (`value=null`) では
 * どれも選択されておらず、ユーザーに明示選択を強制する。
 */
export function PublishScopeSelect({
  value,
  onChange,
  name = "publishScope",
  disabled = false,
}: {
  value: PublishScopeValue | null;
  onChange: (value: PublishScopeValue) => void;
  name?: string;
  disabled?: boolean;
}) {
  return (
    <fieldset style={fieldsetStyle} aria-label="公開先">
      <legend style={legendStyle}>公開先（必須・明示選択）</legend>
      {SCOPE_OPTIONS.map((opt) => {
        const id = `${name}-${opt.value}`;
        const checked = value === opt.value;
        return (
          <label key={opt.value} htmlFor={id} style={optionStyle(checked)}>
            <input
              id={id}
              type="radio"
              name={name}
              value={opt.value}
              checked={checked}
              disabled={disabled}
              onChange={() => onChange(opt.value)}
            />
            <span>
              <span style={labelStyle}>{opt.label}</span>
              <span style={descStyle}>{opt.description}</span>
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

const fieldsetStyle: React.CSSProperties = {
  border: "1px solid #e5e7eb",
  borderRadius: "8px",
  padding: "0.75rem 1rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.4rem",
};

const legendStyle: React.CSSProperties = { fontSize: "0.85rem", fontWeight: 600, color: "#374151" };

function optionStyle(checked: boolean): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "flex-start",
    gap: "0.5rem",
    padding: "0.4rem 0.5rem",
    borderRadius: "6px",
    cursor: "pointer",
    background: checked ? "#eff6ff" : "transparent",
  };
}

const labelStyle: React.CSSProperties = { display: "block", fontWeight: 600, fontSize: "0.9rem" };

const descStyle: React.CSSProperties = { display: "block", fontSize: "0.78rem", color: "#6b7280" };
