import type { ReactNode } from "react";
import { color, fontSize, radius } from "./tokens";

/**
 * ステータスバッジのトーン。色は意味の補助で、**ラベルテキストが意味の本体**（NFR05: 色のみに依存
 * しない / 色覚多様性対応）。アイコンは装飾（`aria-hidden`）でテキストを置き換えない。
 */
export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info";

const TONE: Record<BadgeTone, { bg: string; fg: string; border: string }> = {
  neutral: { bg: color.neutralBg, fg: color.neutralFg, border: color.neutralBorder },
  success: { bg: color.successBg, fg: color.successFg, border: color.successBorder },
  warning: { bg: color.warningBg, fg: color.warningFg, border: color.warningBorder },
  danger: { bg: color.dangerBg, fg: color.dangerFg, border: color.dangerBorder },
  info: { bg: color.infoBg, fg: color.infoFg, border: color.infoBorder },
};

/**
 * 「色＋テキスト（＋任意の装飾アイコン）」のステータスバッジ。稼働中/無効・online/down など、
 * これまで各一覧ページがインライン style で個別に組んでいたバッジを 1 つに集約する。
 *
 * @example
 * <StatusBadge tone="success" icon="●">稼働中</StatusBadge>
 * <StatusBadge tone="danger">無効</StatusBadge>
 */
export function StatusBadge({
  tone = "neutral",
  icon,
  children,
}: {
  tone?: BadgeTone;
  /** 先頭に置く装飾グリフ（例: "●" / "⚠"）。意味はテキスト側が担うため省略可。 */
  icon?: string;
  children: ReactNode;
}) {
  const t = TONE[tone];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.3rem",
        padding: "0.15rem 0.6rem",
        borderRadius: radius.pill,
        fontSize: fontSize.xs,
        fontWeight: 600,
        lineHeight: 1.4,
        background: t.bg,
        color: t.fg,
        border: `1px solid ${t.border}`,
        whiteSpace: "nowrap",
      }}
    >
      {icon ? <span aria-hidden="true">{icon}</span> : null}
      {children}
    </span>
  );
}
