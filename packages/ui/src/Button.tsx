"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { useState } from "react";
import { color, radius } from "./tokens";

/**
 * ボタンの見た目バリアント。`danger` は破壊的操作（削除/失効/無効化）用。
 */
export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";

const VARIANT: Record<ButtonVariant, { bg: string; bgHover: string; fg: string; border: string }> =
  {
    primary: { bg: color.primary, bgHover: color.primaryHover, fg: "#fff", border: color.primary },
    secondary: { bg: "#fff", bgHover: color.bgSoft, fg: color.ink, border: color.border },
    danger: { bg: color.dangerFg, bgHover: "#991b1b", fg: "#fff", border: color.dangerFg },
    ghost: { bg: "transparent", bgHover: color.bgSoft, fg: color.ink, border: "transparent" },
  };

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  children: ReactNode;
};

/**
 * ブランド共通ボタン（**client**）。hover / focus の背景変化を内包するので、CSS を import せずに
 * どのページでも一貫した押下感が出る（インライン style 主体の既存コードと共存）。React 19 では
 * client コンポーネントを Server Component から serializable props（type/disabled 等）で描画できる。
 *
 * - 既定 `type="button"`（呼出側が `type="submit"` で上書き可）。暗黙 submit 事故を防ぐ。
 * - `disabled` 中は hover 色を出さず、cursor/opacity で不活性を示す。
 * - その他の `<button>` 属性（onClick / aria-* / autoFocus 等）はそのまま透過。
 */
export function Button({
  variant = "primary",
  type,
  disabled,
  style,
  children,
  onMouseEnter,
  onMouseLeave,
  onFocus,
  onBlur,
  ...rest
}: ButtonProps) {
  const [hover, setHover] = useState(false);
  const v = VARIANT[variant];
  return (
    <button
      type={type ?? "button"}
      disabled={disabled}
      onMouseEnter={(e) => {
        setHover(true);
        onMouseEnter?.(e);
      }}
      onMouseLeave={(e) => {
        setHover(false);
        onMouseLeave?.(e);
      }}
      onFocus={(e) => {
        setHover(true);
        onFocus?.(e);
      }}
      onBlur={(e) => {
        setHover(false);
        onBlur?.(e);
      }}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "0.4rem",
        border: `1px solid ${v.border}`,
        borderRadius: radius.md,
        padding: "0.55rem 1.1rem",
        fontSize: "0.95rem",
        fontWeight: 600,
        lineHeight: 1.2,
        cursor: disabled ? "default" : "pointer",
        background: disabled ? v.bg : hover ? v.bgHover : v.bg,
        color: v.fg,
        opacity: disabled ? 0.55 : 1,
        transition: "background 0.15s ease",
        ...style,
      }}
      {...rest}
    >
      {children}
    </button>
  );
}
