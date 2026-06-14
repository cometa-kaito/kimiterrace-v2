import { type ContentStatusValue, statusLabel, statusTone } from "@/lib/contents/publish-view";

/**
 * F04: コンテンツの公開状態バッジ (下書き / 公開中 / 非公開)。
 * 即公開フローでは状態が一目で分かることが安全網の前提なので、状態を明示的に色分け表示する。
 */
export function ContentStatusBadge({ status }: { status: ContentStatusValue }) {
  return (
    <span style={badgeStyle(statusTone(status))} aria-label={`状態: ${statusLabel(status)}`}>
      {statusLabel(status)}
    </span>
  );
}

function badgeStyle(tone: "neutral" | "success" | "muted"): React.CSSProperties {
  const palette: Record<typeof tone, { bg: string; fg: string }> = {
    success: { bg: "#dcfce7", fg: "#166534" },
    muted: { bg: "#f3f4f6", fg: "#6b7280" },
    neutral: { bg: "#dbeafe", fg: "#1e40af" },
  };
  const { bg, fg } = palette[tone];
  return {
    display: "inline-block",
    padding: "0.1rem 0.5rem",
    borderRadius: "999px",
    fontSize: "0.78rem",
    fontWeight: 600,
    background: bg,
    color: fg,
  };
}
