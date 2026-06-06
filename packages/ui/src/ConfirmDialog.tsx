"use client";

import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { Button } from "./Button";
import { color, radius, space } from "./tokens";

/**
 * 確認の重さ。`danger` は破壊的操作（削除/失効/無効化/全生徒への公開）で確認ボタンを赤くする。
 */
export type ConfirmTone = "primary" | "danger";

/**
 * 高リスク操作の確認モーダル（**client・controlled**）。`window.confirm` の置換で、これまで
 * 確認の有無がページごとにバラついていた（失効/無効化は2段確認・公開は無確認…）のを 1 つに統一する。
 *
 * アクセシビリティ:
 * - `role="alertdialog"` + `aria-modal`。開いたら**ダイアログ本体にフォーカス**を移す（確認ボタンに
 *   自動フォーカスしない＝Enter での誤確認を防ぐ。破壊操作では特に重要）。
 * - Esc で取消（`pending` 中は無効）。背景クリックでも取消（本体クリックは透過しない）。
 *
 * 状態は呼出側が持つ（`open` / `pending`）。非同期実行は `onConfirm` 内で行い、実行中は `pending` を
 * 立てると両ボタンが無効化され確認側が「処理中…」になる。
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "実行する",
  cancelLabel = "キャンセル",
  tone = "primary",
  pending = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: ConfirmTone;
  /** 実行中。両ボタンを無効化し確認側を「処理中…」にする。Esc/背景クリックも無効化。 */
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    // 開いたらダイアログ本体へフォーカス（確認ボタンへ自動フォーカスしない＝誤確認防止）。
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !pending) {
        onCancel();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, pending, onCancel]);

  if (!open) {
    return null;
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 背景クリックでの取消はマウス補助。キーボード等価は Esc（上の document keydown）で提供済み
    <div
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget && !pending) {
          onCancel();
        }
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(17, 24, 39, 0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: space.lg,
        zIndex: 1000,
      }}
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : undefined}
        tabIndex={-1}
        style={{
          background: "#fff",
          borderRadius: radius.lg,
          maxWidth: "26rem",
          width: "100%",
          padding: space.xl,
          boxShadow: "0 20px 50px rgba(0, 0, 0, 0.25)",
          outline: "none",
        }}
      >
        <h2 style={{ margin: 0, fontSize: "1.1rem", color: color.ink }}>{title}</h2>
        {description ? (
          <p
            style={{
              margin: `${space.md} 0 0`,
              color: color.muted,
              fontSize: "0.9rem",
              lineHeight: 1.6,
            }}
          >
            {description}
          </p>
        ) : null}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: space.sm,
            marginTop: space.xl,
          }}
        >
          <Button variant="secondary" onClick={onCancel} disabled={pending}>
            {cancelLabel}
          </Button>
          <Button
            variant={tone === "danger" ? "danger" : "primary"}
            onClick={onConfirm}
            disabled={pending}
          >
            {pending ? "処理中…" : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
