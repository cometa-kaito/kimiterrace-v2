import type { EffectiveDailyData, MergedSection } from "@/lib/signage/effective-daily-data";
import type { EffectiveAd } from "@kimiterrace/db";

/**
 * サイネージ盤面の**静的描画** (#48-E1)。schedule / notice / assignment / quiet_hours と
 * 実効広告を 1 画面に並べる。**Server Component** (DB 由来の確定データをそのまま描画)。
 *
 * 再生制御 (広告ローテーション・自動更新ポーリング/SSE) は **Client Island = #48-E2** に分離する
 * (issue #117 の #48-E1/#48-E2 分割方針)。本コンポーネントは「いま表示すべき確定状態」のみ描く。
 *
 * 注: schedule/notice/assignment の各要素 (JSONB) の内部構造は #48-A で opaque 保持されており、
 * 正式なスキーマは #48-H / #48-I (エディタ各セクション) で確定する。ここでは要素から代表ラベルを
 * **防御的に**抽出して表示する暫定描画とする (構造確定後に項目別の richな描画へ差し替え)。
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
        <Section title="時間割" section={daily.schedules} />
        <Section title="連絡" section={daily.notices} />
        <Section title="課題" section={daily.assignments} />
        <Section title="静粛時間" section={daily.quietHours} />
      </div>

      <section aria-label="広告" style={adsWrapStyle}>
        <h2 style={sectionTitleStyle}>広告 ({ads.length})</h2>
        {ads.length === 0 ? (
          <p style={emptyStyle}>表示する広告はありません</p>
        ) : (
          <ul style={adsListStyle}>
            {ads.map((ad) => (
              <li key={ad.adId} style={adItemStyle}>
                <span style={adMediaStyle}>{ad.mediaType === "video" ? "🎬" : "🖼"}</span>
                <span style={{ fontSize: `${ad.captionFontScale}rem` }}>
                  {ad.caption ?? ad.mediaUrl}
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

function Section({ title, section }: { title: string; section: MergedSection }) {
  return (
    <section aria-label={title} style={sectionStyle}>
      <h2 style={sectionTitleStyle}>
        {title}
        {section.source && section.source !== "class" ? (
          <span style={badgeStyle}>{section.source === "school" ? "学校共通" : "学年共通"}</span>
        ) : null}
      </h2>
      {section.items.length === 0 ? (
        <p style={emptyStyle}>なし</p>
      ) : (
        <ol style={itemsStyle}>
          {section.items.map((item, i) => (
            // 要素は順序が意味を持ち再並びしないため index key で十分。
            // biome-ignore lint/suspicious/noArrayIndexKey: 静的・不変リストの描画
            <li key={i} style={itemStyle}>
              {itemLabel(item)}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** opaque な JSONB 要素から代表ラベルを防御的に取り出す (構造未確定のための暫定)。 */
function itemLabel(item: unknown): string {
  if (typeof item === "string") {
    return item;
  }
  if (item && typeof item === "object") {
    const rec = item as Record<string, unknown>;
    for (const key of ["title", "label", "text", "subject", "name", "content"]) {
      const v = rec[key];
      if (typeof v === "string" && v.length > 0) {
        return v;
      }
    }
  }
  return JSON.stringify(item);
}

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
const adMediaStyle: React.CSSProperties = { fontSize: "1.1rem" };
const badgeStyle: React.CSSProperties = {
  fontSize: "0.7rem",
  padding: "0.1rem 0.4rem",
  borderRadius: "999px",
  background: "#e5e7eb",
  color: "#374151",
};
