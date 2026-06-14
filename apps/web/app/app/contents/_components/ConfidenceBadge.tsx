import { needsReview } from "@/lib/contents/publish-view";

/**
 * F04.3: AI 確信度フラグ。
 *
 * `confidence_score < 0.7` のコンテンツに「⚠️ 要確認」バッジ + AI 推測の根拠引用を表示する。
 * 確信度が高い / 未取得 (人手作成など) の場合は **何も描画しない** (null)。
 *
 * 注: 確信度の出所は AI 抽出 (`ai_extractions.confidence_score`) 側で、`contents` には現状
 * 列が無い (要件 F04.3 は `contents.confidence_score` を想定するがスキーマ未整合)。本コンポーネントは
 * `score` を prop で受ける純粋表示で、データ配線 (どの値を渡すか) は別スライスで解決する。
 */
export function ConfidenceBadge({
  score,
  evidence,
}: {
  score?: number | null;
  evidence?: string | null;
}) {
  if (!needsReview(score)) {
    return null;
  }
  return (
    <output style={wrapStyle} aria-label="要確認">
      <span style={badgeStyle}>⚠️ 要確認</span>
      <span style={textStyle}>
        AI の確信度が低いコンテンツです。公開前に内容を確認してください。
        {evidence ? <span style={evidenceStyle}>根拠: {evidence}</span> : null}
      </span>
    </output>
  );
}

const wrapStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: "0.5rem",
  padding: "0.5rem 0.75rem",
  borderRadius: "8px",
  background: "#fffbeb",
  border: "1px solid #fde68a",
};

const badgeStyle: React.CSSProperties = {
  flexShrink: 0,
  fontWeight: 700,
  fontSize: "0.8rem",
  color: "#92400e",
};

const textStyle: React.CSSProperties = { fontSize: "0.82rem", color: "#78350f" };

const evidenceStyle: React.CSSProperties = {
  display: "block",
  marginTop: "0.25rem",
  color: "#92400e",
};
