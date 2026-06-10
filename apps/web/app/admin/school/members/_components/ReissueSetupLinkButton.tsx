"use client";

import { reissueStaffSetupLinkAction } from "@/lib/role-management/member-actions";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";

/**
 * F11 (#324 follow-up B1): 自校 teacher の **初回パスワード設定リンク再発行**ボタン。**Client Component** —
 * 教職員一覧の各行 (管理可かつ稼働中の teacher) で操作する。
 *
 * `createStaffAction` の setupLink は発行時に一度しか表示されないため、教員がそれを紛失/失効すると復旧手段が
 * 無かった (運用の行き止まり)。本ボタンはアカウントを保ったまま新しい設定リンクを発行する復旧導線。認可・RLS・
 * role 境界・IdP リンク生成・監査は `reissueStaffSetupLinkAction` が担保するので、ここは操作と **再発行リンクの
 * 提示 (コピー)** に徹する。コピー UI / clipboard 失敗時の手動コピー誘導は StaffCreateForm と同方針 (B2 と同じ
 * 「コピーできたか分からない」詰まりを避ける)。
 *
 * リンクは oobCode を含む secret 相当なので、**この画面で提示するのみ**で保存せず、閉じると state から消える。
 */
export function ReissueSetupLinkButton({
  userId,
  displayName,
}: {
  userId: string;
  displayName: string;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  // clipboard 失敗時に readonly 入力を選択状態へ誘導するための参照。
  const linkInputRef = useRef<HTMLInputElement>(null);
  // オーバーレイを開いたときにフォーカスを移す先 (キーボード/AT 利用者の文脈移動、ConfirmDialog と同方針)。
  const dialogRef = useRef<HTMLDivElement>(null);

  // 閉じると再発行リンクを state から破棄する (secret を画面に残さない)。setState は安定なので deps は空。
  const close = useCallback(() => {
    setLink(null);
    setError(null);
    setCopied(false);
    setCopyFailed(false);
  }, []);

  // オーバーレイ表示時に本体へフォーカスし、Esc で閉じられるようにする (NFR05、ConfirmDialog の a11y 水準に合わせる)。
  useEffect(() => {
    if (!link) {
      return;
    }
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        close();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [link, close]);

  function run() {
    setError(null);
    startTransition(async () => {
      const res = await reissueStaffSetupLinkAction({ userId });
      if (res.ok) {
        setLink(res.data.setupLink);
        setCopied(false);
        setCopyFailed(false);
      } else {
        setError(res.error.message);
      }
    });
  }

  async function copyLink() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setCopyFailed(false);
    } catch {
      // clipboard 不可環境 (非 HTTPS / 権限拒否 / 旧ブラウザ)。readonly 入力を選択状態にして手動コピーへ
      // 確実に誘導し、その旨を明示する (StaffCreateForm と同じ B2 回避)。
      setCopied(false);
      setCopyFailed(true);
      linkInputRef.current?.focus();
      linkInputRef.current?.select();
    }
  }

  return (
    <span style={wrapStyle}>
      <button type="button" onClick={run} disabled={pending} style={btnStyle}>
        {pending ? "…" : "設定リンク再発行"}
      </button>
      {error ? <output style={errorStyle}>{error}</output> : null}

      {link ? (
        // 行内に長い URL を出すと表のレイアウトが崩れるため、オーバーレイで提示する。背景クリックでも閉じる
        // (Esc は上の keydown と等価。マウス補助)。
        // biome-ignore lint/a11y/noStaticElementInteractions: 背景クリックでの取消はマウス補助。キーボード等価は Esc で提供済み
        <div
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              close();
            }
          }}
          style={overlayStyle}
        >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label={`「${displayName}」の初回パスワード設定リンク`}
            tabIndex={-1}
            style={panelStyle}
          >
            <h2 style={panelTitleStyle}>「{displayName}」の設定リンク</h2>
            <p style={warnNoteStyle}>
              ⚠ このリンクは<strong>この画面でのみ表示</strong>
              されます。今コピーして本人へ共有してください（メール自動送信は行いません）。
            </p>
            <label style={labelStyle}>
              初回パスワード設定リンク
              <input ref={linkInputRef} readOnly value={link} style={inputStyle} />
            </label>
            <div style={actionsRowStyle}>
              <button type="button" onClick={copyLink} style={primaryBtnStyle}>
                {copied ? "コピーしました" : "リンクをコピー"}
              </button>
              <button type="button" onClick={close} style={closeBtnStyle}>
                閉じる
              </button>
            </div>
            {copyFailed ? (
              <p role="status" style={copyHintStyle}>
                自動コピーできませんでした。上のリンクが選択されています。手動でコピー（Ctrl/⌘＋C）してください。
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </span>
  );
}

const wrapStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.4rem",
};
const btnStyle: React.CSSProperties = {
  padding: "0.15rem 0.6rem",
  background: "#fff",
  color: "#374151",
  border: "1px solid #d1d5db",
  borderRadius: "6px",
  fontSize: "0.78rem",
  cursor: "pointer",
};
const errorStyle: React.CSSProperties = { color: "#b91c1c", fontSize: "0.75rem" };
const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(17, 24, 39, 0.45)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "1.5rem",
  zIndex: 1000,
};
const panelStyle: React.CSSProperties = {
  background: "#fff",
  borderRadius: "10px",
  maxWidth: "30rem",
  width: "100%",
  padding: "1.5rem",
  boxShadow: "0 20px 50px rgba(0, 0, 0, 0.25)",
  display: "grid",
  gap: "0.85rem",
  textAlign: "left",
  outline: "none",
};
const panelTitleStyle: React.CSSProperties = { margin: 0, fontSize: "1.05rem", color: "#111827" };
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
const actionsRowStyle: React.CSSProperties = {
  display: "flex",
  gap: "0.75rem",
  alignItems: "center",
};
const primaryBtnStyle: React.CSSProperties = {
  padding: "0.5rem 1.1rem",
  background: "#1d4ed8",
  color: "#fff",
  border: "none",
  borderRadius: "6px",
  fontSize: "0.9rem",
  cursor: "pointer",
};
const closeBtnStyle: React.CSSProperties = {
  padding: "0.5rem 1.1rem",
  background: "#fff",
  color: "#374151",
  border: "1px solid #d1d5db",
  borderRadius: "6px",
  fontSize: "0.9rem",
  cursor: "pointer",
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
