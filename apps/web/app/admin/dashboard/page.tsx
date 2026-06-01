import { requireRole } from "@/lib/auth/guard";
import { PUBLISHER_ROLES } from "@/lib/contents/publish-core";
import { densifyHourly, formatHour, hasHourlyData } from "@/lib/dashboard/hourly";
import { densifyPresenceHourly, hasPresenceData } from "@/lib/dashboard/presence";
import { withSession } from "@/lib/db";
import {
  type DailyEventCount,
  getDailyEventCounts,
  getEventStats,
  getHourlyEventCounts,
  getHourlyPresenceCounts,
  type HourlyEventCount,
  type HourlyPresenceCount,
} from "@kimiterrace/db";

/**
 * F08 (#44): 効果ダッシュボード 第1スライス (`/admin/dashboard`)。**Server Component**。
 *
 * F07 (#43) が `events` に記録した行動ログ (view/tap) を、自校スコープで集計表示する。
 *
 * **認可 (#166 と整合)**: `/admin` レイアウトの `requireRole(ADMIN_ROLES)` に加え、本ページは
 * `requireRole(PUBLISHER_ROLES)` (school_admin / teacher) に限定する。F08 仕様の「ダッシュボード
 * (school_admin / teacher 閲覧、school_id スコープ)」に対応する自校ビューで、system_admin 向けの
 * cross-tenant ビューは別スライス (専用画面) で用意する。コンテンツ一覧 (#166) と同じ方針で
 * system_admin はここでは早期 403 (`/forbidden`) に倒し、自校用画面に横断データを混ぜない。
 *
 * `withSession` で RLS context を張り集計する (school 境界は RLS が DB レベルで強制、CLAUDE.md
 * ルール2)。サマリ + content 別ランキング + **日次の推移** (JST 暦日、第2スライス) を表示。
 * 重い描画ライブラリ (Recharts/Visx) は導入せず、時系列は **CSS バーの軽量 SSR** で描く (依存追加を
 * 避ける)。人感センサーヒートマップ・AI 効果コメントは後続スライスで追加する。
 *
 * **アクセシビリティ (NFR05 / WCAG 2.2 AA)**: 数値は文字ラベル付きで提示し、色のみに依存しない。
 * ランキングは `<table>` + `<th scope>`、時系列バーも各行に件数テキストを併記して読み上げ可能にする。
 */
export default async function DashboardPage() {
  await requireRole(PUBLISHER_ROLES);
  // 同一 RLS context (1 tx) で全クエリを実行する。
  const { stats, daily, hourly, presence } = await withSession(async (tx) => ({
    stats: await getEventStats(tx),
    daily: await getDailyEventCounts(tx),
    hourly: await getHourlyEventCounts(tx),
    presence: await getHourlyPresenceCounts(tx),
  }));

  return (
    <section>
      <div style={headerStyle}>
        <h1 style={titleStyle}>効果ダッシュボード</h1>
        {/* ADR-020 公開透明性: 来場検知は PIR センサーでカメラ非使用。常時バッジで明示する。 */}
        <span
          style={cameraBadgeStyle}
          title="来場検知は人感(PIR)センサーのみ。カメラ・録画は使用しません。"
        >
          カメラ不使用
        </span>
      </div>
      <p style={subtitleStyle}>過去 {stats.sinceDays} 日間の反応</p>

      <div style={cardsStyle}>
        <SummaryCard label="延べ表示数 (engagement)" value={stats.totals.view} />
        <SummaryCard label="タップ (tap)" value={stats.totals.tap} />
        <SummaryCard label="Q&A (ask)" value={stats.totals.ask} />
      </div>

      <h2 style={sectionTitleStyle}>コンテンツ別の反応</h2>
      {stats.ranking.length === 0 ? (
        <p style={emptyStyle}>対象期間の反応データはまだありません。</p>
      ) : (
        <table style={tableStyle}>
          <caption style={captionStyle}>反応が多い順のコンテンツ一覧</caption>
          <thead>
            <tr>
              <th scope="col" style={thLeftStyle}>
                コンテンツ
              </th>
              <th scope="col" style={thNumStyle}>
                表示
              </th>
              <th scope="col" style={thNumStyle}>
                タップ
              </th>
              <th scope="col" style={thNumStyle}>
                合計
              </th>
            </tr>
          </thead>
          <tbody>
            {stats.ranking.map((row) => (
              <tr key={row.contentId}>
                <th scope="row" style={tdLeftStyle}>
                  {row.title}
                </th>
                <td style={tdNumStyle}>{row.views}</td>
                <td style={tdNumStyle}>{row.taps}</td>
                <td style={tdNumTotalStyle}>{row.total}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 style={sectionTitleStyle}>日次の推移</h2>
      <DailyTrend daily={daily} />

      <h2 style={sectionTitleStyle}>時間帯別の傾向</h2>
      <HourlyTrend hourly={hourly} />

      <h2 style={sectionTitleStyle}>時間帯別の在室 (人感センサー)</h2>
      <PresenceTrend presence={presence} />

      {/* ADR-025: 延べ表示数(engagement) と 広告主向け到達数(reach) を取り違えないよう明示する。 */}
      <p style={footnoteStyle}>
        「延べ表示数
        (engagement)」は表示の延べ回数で、同じ内容を複数回・複数端末で表示した分も数えます。
        広告主向けの「到達数 (reach)」は別指標 (重複排除済) で、月次レポートで扱います。
      </p>
    </section>
  );
}

function SummaryCard({ label, value }: { label: string; value: number }) {
  return (
    <div style={cardStyle}>
      <span style={cardLabelStyle}>{label}</span>
      <span style={cardValueStyle}>{value.toLocaleString("ja-JP")}</span>
    </div>
  );
}

/**
 * 日次推移を CSS バーで軽量描画する (Recharts 等の依存を持たない)。バー長は各日の合計を
 * 最大日比で正規化。色のみに依存しないよう、各行に日付ラベルと view/tap の件数テキストを併記する
 * (WCAG 2.2 AA、NFR05)。
 */
function DailyTrend({ daily }: { daily: DailyEventCount[] }) {
  if (daily.length === 0) {
    return <p style={emptyStyle}>対象期間の推移データはまだありません。</p>;
  }
  const max = Math.max(...daily.map((d) => d.views + d.taps), 1);
  return (
    <ul style={trendListStyle}>
      {daily.map((d) => {
        const total = d.views + d.taps;
        return (
          <li key={d.day} style={trendRowStyle}>
            <span style={trendDayStyle}>{formatDay(d.day)}</span>
            <span style={trendBarTrackStyle}>
              <span style={{ ...trendBarFillStyle, width: `${(total / max) * 100}%` }} />
            </span>
            <span style={trendCountStyle}>
              表示 {d.views} / タップ {d.taps}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** "YYYY-MM-DD" を "M/D" 表示にする (DB が返す JST 暦日文字列をそのまま整形)。 */
function formatDay(day: string): string {
  const parts = day.split("-");
  return parts.length === 3 ? `${Number(parts[1])}/${Number(parts[2])}` : day;
}

/**
 * 時間帯別 (JST hour-of-day) の反応を CSS バーで軽量描画する。0〜23 時を密に並べ (events のない
 * 時間も 0 として 1 日全体を見せる)、バー長は最大時比で正規化。日次推移と同じく色のみに依存せず、
 * 各行に「時」ラベルと view/tap の件数テキストを併記する (WCAG 2.2 AA、NFR05)。
 */
function HourlyTrend({ hourly }: { hourly: HourlyEventCount[] }) {
  if (!hasHourlyData(hourly)) {
    return <p style={emptyStyle}>対象期間の時間帯データはまだありません。</p>;
  }
  const dense = densifyHourly(hourly);
  const max = Math.max(...dense.map((h) => h.views + h.taps), 1);
  return (
    <ul style={trendListStyle}>
      {dense.map((h) => {
        const total = h.views + h.taps;
        return (
          <li key={h.hour} style={trendRowStyle}>
            <span style={trendDayStyle}>{formatHour(h.hour)}</span>
            <span style={trendBarTrackStyle}>
              <span style={{ ...trendBarFillStyle, width: `${(total / max) * 100}%` }} />
            </span>
            <span style={trendCountStyle}>
              表示 {h.views} / タップ {h.taps}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * 時間帯別 (JST hour-of-day) の **在室 (presence)** を CSS バーで軽量描画する。F13 人感 (PIR)
 * センサー由来の `type='presence'` を集計したもので、view/tap (反応) とは別の「人がいたか」指標。
 * 0〜23 時を密に並べ、バー長は最大時比で正規化。色のみに依存せず各行に「時」ラベルと在室件数
 * テキストを併記する (WCAG 2.2 AA、NFR05)。バー色も view/tap (青) と分けて緑にする (ADR-020:
 * 来場検知はカメラ非使用の PIR、ページ上部の「カメラ不使用」バッジと整合)。
 */
function PresenceTrend({ presence }: { presence: HourlyPresenceCount[] }) {
  if (!hasPresenceData(presence)) {
    return <p style={emptyStyle}>対象期間の在室データはまだありません。</p>;
  }
  const dense = densifyPresenceHourly(presence);
  const max = Math.max(...dense.map((h) => h.presence), 1);
  return (
    <ul style={trendListStyle}>
      {dense.map((h) => (
        <li key={h.hour} style={trendRowStyle}>
          <span style={trendDayStyle}>{formatHour(h.hour)}</span>
          <span style={trendBarTrackStyle}>
            <span style={{ ...presenceBarFillStyle, width: `${(h.presence / max) * 100}%` }} />
          </span>
          <span style={trendCountStyle}>在室 {h.presence}</span>
        </li>
      ))}
    </ul>
  );
}

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
};
const titleStyle: React.CSSProperties = { fontSize: "1.3rem", fontWeight: 700, margin: 0 };
const cameraBadgeStyle: React.CSSProperties = {
  fontSize: "0.7rem",
  fontWeight: 600,
  color: "#065f46",
  background: "#d1fae5",
  border: "1px solid #6ee7b7",
  borderRadius: "999px",
  padding: "0.15rem 0.6rem",
};
const subtitleStyle: React.CSSProperties = { color: "#6b7280", margin: "0.35rem 0 1.25rem" };
const cardsStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "1rem",
  marginBottom: "1.75rem",
};
const cardStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.35rem",
  minWidth: "9rem",
  padding: "1rem 1.25rem",
  border: "1px solid #e5e7eb",
  borderRadius: "10px",
};
const cardLabelStyle: React.CSSProperties = { fontSize: "0.8rem", color: "#6b7280" };
const cardValueStyle: React.CSSProperties = {
  fontSize: "1.8rem",
  fontWeight: 700,
  color: "#111827",
};
const sectionTitleStyle: React.CSSProperties = {
  fontSize: "1.05rem",
  fontWeight: 700,
  marginBottom: "0.75rem",
};
const emptyStyle: React.CSSProperties = { color: "#6b7280" };
const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "0.9rem",
};
const captionStyle: React.CSSProperties = {
  textAlign: "left",
  color: "#6b7280",
  fontSize: "0.8rem",
  marginBottom: "0.5rem",
};
const thLeftStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "0.5rem 0.6rem",
  borderBottom: "2px solid #e5e7eb",
  fontWeight: 600,
};
const thNumStyle: React.CSSProperties = {
  textAlign: "right",
  padding: "0.5rem 0.6rem",
  borderBottom: "2px solid #e5e7eb",
  fontWeight: 600,
  width: "5.5rem",
};
const tdLeftStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "0.5rem 0.6rem",
  borderBottom: "1px solid #f3f4f6",
  fontWeight: 500,
};
const tdNumStyle: React.CSSProperties = {
  textAlign: "right",
  padding: "0.5rem 0.6rem",
  borderBottom: "1px solid #f3f4f6",
  fontVariantNumeric: "tabular-nums",
};
const tdNumTotalStyle: React.CSSProperties = { ...tdNumStyle, fontWeight: 700 };
const trendListStyle: React.CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: "0.4rem",
};
const trendRowStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "3rem 1fr auto",
  alignItems: "center",
  gap: "0.75rem",
  fontSize: "0.85rem",
};
const trendDayStyle: React.CSSProperties = { color: "#6b7280", textAlign: "right" };
const trendBarTrackStyle: React.CSSProperties = {
  display: "block",
  background: "#f3f4f6",
  borderRadius: "4px",
  height: "0.9rem",
  overflow: "hidden",
};
const trendBarFillStyle: React.CSSProperties = {
  display: "block",
  background: "#3b82f6",
  height: "100%",
};
// 在室 (presence) バーは view/tap (青) と区別するため緑。色のみに依存しない (件数テキスト併記、NFR05)。
const presenceBarFillStyle: React.CSSProperties = {
  display: "block",
  background: "#10b981",
  height: "100%",
};
const trendCountStyle: React.CSSProperties = {
  color: "#374151",
  fontVariantNumeric: "tabular-nums",
  whiteSpace: "nowrap",
};
const footnoteStyle: React.CSSProperties = {
  color: "#9ca3af",
  fontSize: "0.8rem",
  marginTop: "1.5rem",
};
