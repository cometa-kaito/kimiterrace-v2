"use client";

import { deleteTvDeviceAction } from "@/lib/tv/config-edit-actions";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";

/**
 * F15 §4.2: TV デバイス削除（ソフトデリート）ボタン。**Client Component** — 認可・RLS テナント分離・
 * 監査（operation=delete）・冪等性は Server Action 側 (`deleteTvDeviceAction`) と RLS が担保するので、
 * ここは確認と結果表示に徹する。
 *
 * **誤操作防止（SchoolDeleteButton と同方針）**: 退役は運用影響が大きい（端末がポーリングしても未登録扱い
 * になり盤面が消える）ため、`window.confirm` の 1 クリックではなく、対象の**確認語の正確な入力**を要求する。
 * 確認語は設置ラベル（例「進路指導室前」）。ラベル未設定の端末は device_id を確認語にフォールバックする。
 *
 * **ソフトデリート**: 削除後も行は残り（履歴保全）。device_id はグローバル UNIQUE のままで再利用はされない
 * （同一 device_id の再登録は不可・撤去端末は別 id で再プロビジョン）。本 UI に「元に戻す」導線は無いため、
 * 文言は「一覧から削除」と明示し不可逆と誤認させない（復活は別経路）。
 */
export function TvDeviceDeleteButton({
  deviceRowId,
  label,
  deviceId,
}: {
  deviceRowId: string;
  label: string | null;
  deviceId: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const inputId = useId();

  // 確認語: ラベルがあればラベル、無ければ device_id。前後空白は許容し、それ以外は完全一致を要求する。
  const confirmWord = (label?.trim() ? label.trim() : deviceId).trim();
  const isLabelWord = !!label?.trim();
  const matches = typed.trim() === confirmWord;

  function reset() {
    setConfirming(false);
    setTyped("");
    setError(null);
  }

  function onSubmit() {
    if (!matches || pending) {
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await deleteTvDeviceAction(deviceRowId);
      if (res.ok) {
        router.push("/ops/tv-devices");
        router.refresh();
      } else {
        setError(res.error.message);
      }
    });
  }

  if (!confirming) {
    return (
      <div style={wrapStyle}>
        <div style={headingRowStyle}>
          <span style={headingStyle}>危険操作</span>
        </div>
        <p style={descStyle}>
          このモニタを一覧から削除（退役）します。削除後はポーリングしても未登録扱いになり盤面が消えます。
          設置情報・履歴は残ります。なお同じ device_id での再登録はできません（再設置する場合は別
          device_id でプロビジョンしてください）。
        </p>
        <button type="button" onClick={() => setConfirming(true)} style={btnStyle}>
          このモニタを削除
        </button>
      </div>
    );
  }

  return (
    <div style={wrapStyle}>
      <div style={headingRowStyle}>
        <span style={headingStyle}>危険操作</span>
      </div>
      <div style={panelStyle}>
        <label htmlFor={inputId} style={labelStyle}>
          削除するには{isLabelWord ? "教室ラベル" : "デバイス ID"}「{confirmWord}
          」を入力してください。
        </label>
        <input
          id={inputId}
          type="text"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          disabled={pending}
          autoComplete="off"
          style={inputStyle}
        />
        <div style={actionsStyle}>
          <button type="button" onClick={reset} disabled={pending} style={cancelStyle}>
            キャンセル
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={!matches || pending}
            style={confirmStyle}
          >
            {pending ? "削除中…" : "削除する"}
          </button>
        </div>
      </div>
      {error ? <output style={errorStyle}>{error}</output> : null}
    </div>
  );
}

const wrapStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.5rem",
  marginTop: "2rem",
  paddingTop: "1.25rem",
  borderTop: "1px solid #fca5a5",
};
const headingRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
};
const headingStyle: React.CSSProperties = { fontSize: "0.9rem", fontWeight: 700, color: "#b91c1c" };
const descStyle: React.CSSProperties = {
  fontSize: "0.82rem",
  color: "#6b7280",
  margin: 0,
  maxWidth: "32rem",
  lineHeight: 1.6,
};
const panelStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.4rem",
  padding: "0.75rem",
  border: "1px solid #fca5a5",
  borderRadius: "8px",
  background: "#fef2f2",
  maxWidth: "26rem",
};
const labelStyle: React.CSSProperties = { fontSize: "0.8rem", color: "#7f1d1d" };
const inputStyle: React.CSSProperties = {
  padding: "0.35rem 0.5rem",
  border: "1px solid #fca5a5",
  borderRadius: "6px",
  fontSize: "0.85rem",
};
const actionsStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "0.5rem",
};
const btnStyle: React.CSSProperties = {
  padding: "0.4rem 0.9rem",
  background: "#fff",
  color: "#b91c1c",
  border: "1px solid #fca5a5",
  borderRadius: "6px",
  fontSize: "0.85rem",
  cursor: "pointer",
  alignSelf: "flex-start",
};
const cancelStyle: React.CSSProperties = {
  padding: "0.35rem 0.8rem",
  background: "#fff",
  color: "#374151",
  border: "1px solid #d1d5db",
  borderRadius: "6px",
  fontSize: "0.82rem",
  cursor: "pointer",
};
const confirmStyle: React.CSSProperties = {
  padding: "0.35rem 0.8rem",
  background: "#b91c1c",
  color: "#fff",
  border: "1px solid #b91c1c",
  borderRadius: "6px",
  fontSize: "0.82rem",
  cursor: "pointer",
};
const errorStyle: React.CSSProperties = { color: "#b91c1c", fontSize: "0.8rem", maxWidth: "26rem" };
