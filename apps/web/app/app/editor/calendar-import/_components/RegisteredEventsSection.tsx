import { eventDateRangeLabel, groupEventsByMonth } from "@/lib/editor/calendar-import-view";
import type { FiscalYearWindow } from "@/lib/editor/calendar-import-core";
import { tokens } from "@kimiterrace/ui";

const { color, radius, fontSize, space } = tokens;

/**
 * 「登録済みの行事」一覧（教員 FB「現状登録されている物を見れて、そこに読み取りの機能があると
 * 分かり易い」対応）。今年度窓の school_calendar_events を**月ごとに見出し + 区切り線**で表示する
 * （server component・データは page.tsx が withSession/RLS 委譲で読み plain props で渡す）。
 * 編集・削除はスコープ外（表示のみ）。由来（ファイル取込 / iCal 連携）は小ラベルで併記する。
 */

/** 一覧 1 行の plain props（page.tsx が DB 行から導出。client には渡らない）。 */
export interface RegisteredEventRow {
  id: string;
  /** YYYY-MM-DD。 */
  startDate: string;
  /** YYYY-MM-DD（単日は null）。 */
  endDate: string | null;
  summary: string | null;
  location: string | null;
  /** `file:` 名前空間（ファイル取込由来）か。判定はサーバ側（FILE_IMPORT_UID_PREFIX）で済ませる。 */
  isFileImport: boolean;
}

export function RegisteredEventsSection({
  events,
  window,
}: {
  events: RegisteredEventRow[];
  window: FiscalYearWindow;
}) {
  const groups = groupEventsByMonth(events, (ev) => ev.startDate);
  return (
    <section style={cardStyle} aria-labelledby="registered-events-heading">
      <h2 id="registered-events-heading" style={sectionHeadingStyle}>
        登録済みの行事
      </h2>
      <p style={hintStyle}>
        {window.fiscalYear} 年度（{window.start}〜{window.end}）に登録されている行事カレンダーです。
      </p>
      {events.length === 0 ? (
        <p style={hintStyle}>まだ行事が登録されていません。下のファイル取込から始められます。</p>
      ) : (
        // モバイルは表ごと横スクロール（列を潰さない・取込プレビューと同作法）。
        <div style={{ overflowX: "auto" }}>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>日付</th>
                <th style={thStyle}>行事名</th>
                <th style={thStyle}>場所</th>
                <th style={thStyle}>由来</th>
              </tr>
            </thead>
            {groups.map((group) => (
              <tbody key={group.monthKey}>
                <tr>
                  <th colSpan={4} scope="colgroup" style={monthHeadingStyle}>
                    {group.label}
                  </th>
                </tr>
                {group.items.map((ev) => (
                  <tr key={ev.id}>
                    <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>
                      {eventDateRangeLabel(ev.startDate, ev.endDate)}
                    </td>
                    <td style={tdStyle}>{ev.summary ?? "（名称なし）"}</td>
                    <td style={tdStyle}>{ev.location ?? ""}</td>
                    <td style={tdStyle}>
                      <span style={ev.isFileImport ? fileChipStyle : icalChipStyle}>
                        {ev.isFileImport ? "ファイル取込" : "iCal 連携"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
      )}
    </section>
  );
}

const cardStyle: React.CSSProperties = {
  display: "grid",
  gap: space.sm,
  padding: "1rem 1.1rem",
  border: `1px solid ${color.border}`,
  borderRadius: radius.lg,
  background: color.surface,
};
const sectionHeadingStyle: React.CSSProperties = {
  margin: 0,
  fontSize: fontSize.md,
  fontWeight: 600,
  color: color.ink,
};
const hintStyle: React.CSSProperties = {
  margin: 0,
  fontSize: fontSize.sm,
  color: color.muted,
};
const tableStyle: React.CSSProperties = {
  borderCollapse: "collapse",
  width: "100%",
  minWidth: "480px",
};
const thStyle: React.CSSProperties = {
  textAlign: "left",
  fontSize: fontSize.xs,
  fontWeight: 600,
  color: color.muted,
  padding: "0.4rem 0.5rem",
  borderBottom: `1px solid ${color.border}`,
  whiteSpace: "nowrap",
};
/** 月見出し行（教員 FB「月順で線で区切って」= 薄地 + 上線で月の境界を明示）。 */
const monthHeadingStyle: React.CSSProperties = {
  textAlign: "left",
  fontSize: fontSize.sm,
  fontWeight: 700,
  color: color.ink,
  background: color.bgSoft,
  padding: "0.45rem 0.5rem",
  borderTop: `2px solid ${color.border}`,
  borderBottom: `1px solid ${color.border}`,
};
const tdStyle: React.CSSProperties = {
  fontSize: fontSize.sm,
  color: color.ink,
  padding: "0.35rem 0.5rem",
  borderBottom: `1px solid ${color.border}`,
  verticalAlign: "middle",
};
const chipBaseStyle: React.CSSProperties = {
  display: "inline-block",
  fontSize: fontSize.xs,
  fontWeight: 600,
  padding: "0.1rem 0.5rem",
  borderRadius: radius.pill,
  whiteSpace: "nowrap",
};
const fileChipStyle: React.CSSProperties = {
  ...chipBaseStyle,
  color: color.neutralFg,
  background: color.neutralBg,
  border: `1px solid ${color.neutralBorder}`,
};
const icalChipStyle: React.CSSProperties = {
  ...chipBaseStyle,
  color: color.infoFg,
  background: color.infoBg,
  border: `1px solid ${color.infoBorder}`,
};
