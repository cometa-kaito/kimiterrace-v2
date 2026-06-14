"use client";

import { updateSchoolConfigValueAction } from "@/lib/system-admin/school-config-actions";
import { CONFIG_VALUE_TEXT_MAX, parseConfigValueText } from "@/lib/system-admin/school-config-core";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";

/**
 * UIUX-03: 学校設定 (school_configs) の value (jsonb) 行内編集フォーム。**Client Component** —
 * `updateSchoolConfigValueAction` を呼び、結果をインライン表示する。認可・検証・監査は
 * Server Action 側 (school-config-actions.ts) と RLS が担保するので、ここは入力収集と
 * 結果表示に徹する (SchoolEditForm と同方針)。
 *
 * - 一覧の各行に `<details>` で畳んで埋め込む (行リンク先ページを増やさない軽量案)。
 * - 送信前に `parseConfigValueText` (school-config-core.ts) でクライアント側も検証する —
 *   Server Action と**同じ規則の単一ソース** (authoritative は Server Action 側)。
 * - 編集対象は**生 JSON** (一覧セルの表示は formatMaskedJson だが、マスク済みテキストを編集させると
 *   保存でデータが壊れるため、編集フォームは原文を出す。value は設定値で生徒 PII を含まない設計)。
 */
export function ConfigValueEditForm({
  configId,
  initialValueText,
}: {
  configId: string;
  initialValueText: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [text, setText] = useState(initialValueText);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // クライアント側の事前検証 (パース不可はここで止める)。規則は Server Action と同一ソース。
    const parsed = parseConfigValueText(text);
    if (!parsed.ok) {
      setMsg({ ok: false, text: parsed.message });
      return;
    }
    startTransition(async () => {
      const res = await updateSchoolConfigValueAction({ id: configId, valueText: text });
      if (res.ok) {
        setMsg({ ok: true, text: "設定値を更新しました。" });
        router.refresh();
      } else {
        setMsg({ ok: false, text: res.error.message });
      }
    });
  }

  return (
    <details style={detailsStyle}>
      <summary style={summaryStyle}>編集</summary>
      <form onSubmit={onSubmit} style={formStyle}>
        <textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setMsg(null);
          }}
          rows={8}
          maxLength={CONFIG_VALUE_TEXT_MAX}
          spellCheck={false}
          aria-label="設定値 (JSON)"
          style={textareaStyle}
        />
        {msg ? (
          <output style={{ ...msgStyle, color: msg.ok ? "#166534" : "#b91c1c" }}>{msg.text}</output>
        ) : null}
        <div style={rowStyle}>
          <button type="submit" disabled={pending} style={btnStyle}>
            {pending ? "保存中…" : "保存する"}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              setText(initialValueText);
              setMsg(null);
            }}
            style={resetBtnStyle}
          >
            元に戻す
          </button>
        </div>
      </form>
    </details>
  );
}

const detailsStyle: React.CSSProperties = { minWidth: "5rem" };
const summaryStyle: React.CSSProperties = {
  cursor: "pointer",
  color: "#1d4ed8",
  fontSize: "0.85rem",
  whiteSpace: "nowrap",
};
const formStyle: React.CSSProperties = {
  display: "grid",
  gap: "0.4rem",
  marginTop: "0.4rem",
  minWidth: "22rem",
};
const textareaStyle: React.CSSProperties = {
  width: "100%",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  fontSize: "0.78rem",
  lineHeight: 1.5,
  padding: "0.5rem 0.6rem",
  border: "1px solid #d1d5db",
  borderRadius: "6px",
  resize: "vertical",
};
const msgStyle: React.CSSProperties = { display: "block", fontSize: "0.82rem" };
const rowStyle: React.CSSProperties = { display: "flex", gap: "0.6rem", alignItems: "center" };
const btnStyle: React.CSSProperties = {
  padding: "0.35rem 0.9rem",
  background: "#1d4ed8",
  color: "#fff",
  border: "none",
  borderRadius: "6px",
  fontSize: "0.85rem",
  cursor: "pointer",
};
const resetBtnStyle: React.CSSProperties = {
  padding: "0.35rem 0.9rem",
  background: "#fff",
  color: "#6b7280",
  border: "1px solid #d1d5db",
  borderRadius: "6px",
  fontSize: "0.85rem",
  cursor: "pointer",
};
