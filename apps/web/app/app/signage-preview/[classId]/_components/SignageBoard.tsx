import { AdThumbnail } from "@/app/_components/AdThumbnail";
import type { EffectiveDailyData, MergedSection } from "@/lib/signage/effective-daily-data";
import { type SignageSectionKind, formatSignageItem } from "@/lib/signage/section-format";
import type { EffectiveAd } from "@kimiterrace/db";

/**
 * サイネージ盤面の**静的描画** (#48-E1)。schedule / notice / assignment / quiet_hours と
 * 実効広告を 1 画面に並べる。**Server Component** (DB 由来の確定データをそのまま描画)。
 *
 * 再生制御 (広告ローテーション・自動更新ポーリング/SSE) は **Client Island = #48-E2** に分離する
 * (issue #117 の #48-E1/#48-E2 分割方針)。本コンポーネントは「いま表示すべき確定状態」のみ描く。
 *
 * 各要素 (JSONB) の整形は `formatSignageItem` (#48-E1/#48-E2 共有) に委譲する。要素スキーマは
 * #48-H / #48-I / #48-J-2 で確定済で、時限・期限・内容・静粛時間帯を捨てずに rich 描画する
 * (opaque な旧データは fail-soft で汎用ラベルにフォールバック)。`SignageClient` (公開) と同一整形。
 */
export function SignageBoard({
  date,
  daily,
  ads,
}: {
  date: string;
  daily: EffectiveDailyData;
  ads: EffectiveAd[];
}) {
  return (
    <div style={rootStyle}>
      <header style={dateHeaderStyle}>{date}</header>

      <div style={gridStyle}>
        <Section title="予定" kind="schedules" section={daily.schedules} />
        <Section title="連絡" kind="notices" section={daily.notices} />
        <Section title="提出物" kind="assignments" section={daily.assignments} />
        {/* 静粛時間は盤面に出さない (2026-06-06 ユーザー確定。実機 SignageClient も非表示)。プレビューを
            実機に一致させるため、ここでも描かない (#48-E1 SignageBoard はプレビュー専用)。 */}
      </div>

      <section aria-label="広告" style={adsWrapStyle}>
        <h2 style={sectionTitleStyle}>広告 ({ads.length})</h2>
        {ads.length === 0 ? (
          <p style={emptyStyle}>表示する広告はありません</p>
        ) : (
          <ul style={adsListStyle}>
            {ads.map((ad) => (
              <li key={ad.adId} style={adItemStyle}>
                <AdThumbnail
                  mediaUrl={ad.mediaUrl}
                  mediaType={ad.mediaType === "video" ? "video" : "image"}
                  caption={ad.caption}
                  size={48}
                />
                <span style={{ fontSize: `${ad.captionFontScale}rem` }}>
                  {ad.caption ?? (ad.mediaType === "video" ? "動画広告" : "画像広告")}
                </span>
                {ad.isInherited ? <span style={badgeStyle}>{ad.sourceScope}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Section({
  title,
  kind,
  section,
}: {
  title: string;
  kind: SignageSectionKind;
  section: MergedSection;
}) {
  return (
    <section aria-label={title} style={sectionStyle}>
      <h2 style={sectionTitleStyle}>
        {title}
        {section.source && section.source !== "class" ? (
          <span style={badgeStyle}>{SOURCE_BADGE_LABEL[section.source]}</span>
        ) : null}
      </h2>
      {section.items.length === 0 ? (
        <p style={emptyStyle}>なし</p>
      ) : (
        <ol style={itemsStyle}>
          {section.items.map((item, i) => {
            const line = formatSignageItem(kind, item);
            // 区切り線（kind:"divider"・PR-B §5.3）: プレビューでも罫線（ラベル任意）として描く（実機と整合）。
            // role="separator" は付けない（interactive role の a11y 制約回避・SignageBoardView と同判断）。
            if (line.divider) {
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: 静的・不変リストの描画
                <li key={i} style={dividerItemStyle} data-divider="true">
                  {line.text || "―――"}
                </li>
              );
            }
            return (
              // 要素は順序が意味を持ち再並びしないため index key で十分。
              // biome-ignore lint/suspicious/noArrayIndexKey: 静的・不変リストの描画
              <li key={i} style={line.emphasis ? itemEmphasisStyle : itemStyle}>
                {line.text}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

/** 採用元 scope → サイネージ継承バッジ文言。class は出さないので含めない (段A-2 で学科共通を追加)。 */
const SOURCE_BADGE_LABEL: Record<"school" | "department" | "grade", string> = {
  school: "学校共通",
  department: "学科共通",
  grade: "学年共通",
};

const rootStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: "1rem" };
const dateHeaderStyle: React.CSSProperties = {
  fontSize: "1.5rem",
  fontWeight: 700,
  borderBottom: "2px solid #1f2937",
  paddingBottom: "0.5rem",
};
const gridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  gap: "1rem",
};
const sectionStyle: React.CSSProperties = {
  border: "1px solid #e5e7eb",
  borderRadius: "8px",
  padding: "0.75rem 1rem",
};
const sectionTitleStyle: React.CSSProperties = {
  fontSize: "1.05rem",
  margin: "0 0 0.5rem",
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
};
const itemsStyle: React.CSSProperties = {
  margin: 0,
  paddingLeft: "1.25rem",
  display: "grid",
  gap: "0.25rem",
};
const itemStyle: React.CSSProperties = { fontSize: "0.95rem" };
// 重要マーク付き連絡 (isHighlight) は太字で強調する。
const itemEmphasisStyle: React.CSSProperties = { fontSize: "0.95rem", fontWeight: 700 };
// 区切り線行（kind:"divider"）。プレビューは簡易描画（muted・ラベル or ダッシュ）で実機の罫線に対応させる。
const dividerItemStyle: React.CSSProperties = {
  fontSize: "0.85rem",
  color: "#9ca3af",
  listStyle: "none",
  textAlign: "center",
};
const emptyStyle: React.CSSProperties = { color: "#9ca3af", margin: 0, fontSize: "0.9rem" };
const adsWrapStyle: React.CSSProperties = { ...sectionStyle, background: "#fafafa" };
const adsListStyle: React.CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "grid",
  gap: "0.4rem",
};
const adItemStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: "0.5rem" };
const badgeStyle: React.CSSProperties = {
  fontSize: "0.7rem",
  padding: "0.1rem 0.4rem",
  borderRadius: "999px",
  background: "#e5e7eb",
  color: "#374151",
};
