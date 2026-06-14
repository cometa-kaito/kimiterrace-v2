import { requireRole } from "@/lib/auth/guard";
import { densifyHourly, formatHour, hasHourlyData } from "@/lib/dashboard/hourly";
import { SYSTEM_ADMIN_ROLES } from "@/lib/system-admin/roles";
import {
  densifyPresenceHeatmap,
  densifyPresenceHourly,
  formatBucket,
  hasPresenceData,
  hasPresenceHeatmapData,
} from "@/lib/dashboard/presence";
import { withSession } from "@/lib/db";
import {
  type DailyEventCount,
  type DailyPresenceCount,
  getDailyEventCounts,
  getDailyPresenceCounts,
  getEventStats,
  getHourlyEventCounts,
  getHourlyPresenceCounts,
  getPresenceQuarterHourHeatmap,
  type HourlyEventCount,
  type HourlyPresenceCount,
  type PresenceHeatmapCell,
} from "@kimiterrace/db";

/**
 * F08 (#44): 効果ダッシュボード 第1スライス (`/app/dashboard`)。**Server Component**。
 *
 * F07 (#43) が `events` に記録した行動ログ (view/tap) を、自校スコープで集計表示する。
 *
 * **認可 (校務DX原則: 監視系は運営専用)**: 効果ダッシュボードは「自校の運営を見る」閲覧系で、先生・
 * 校長の校務を楽にする機能ではない。`/admin` レイアウトの `requireRole(ADMIN_ROLES)` に加え、本ページは
 * `requireRole(SYSTEM_ADMIN_ROLES)` (system_admin のみ) に締める。teacher / school_admin は nav から
 * 撤去済み + ここで 403 (`/forbidden`)。全校横断の効果ダッシュボードは `/ops/dashboard` で
 * 運営に提供する。
 *
 * 注: 本ページの集計は school_id スコープ前提だが、system_admin は school_id を持たず通常 nav からは
 * 到達しない (撤去済)。URL 直打ちの system_admin に対しては RLS の `system_admin_full_access` policy
 * 下で集計が走り (空表示で落ちはしない)、実害は無い。
 *
 * `withSession` で RLS context を張り集計する (school 境界は RLS が DB レベルで強制、CLAUDE.md
 * ルール2)。サマリ + content 別ランキング + **日次の推移** (JST 暦日、第2スライス) を表示。
 * 重い描画ライブラリ (Recharts/Visx) は導入せず、時系列は **CSS バーの軽量 SSR** で描く (依存追加を
 * 避ける)。
 *
 * 注: **AI 効果コメント (`<EffectCommentPanel />`) は本ページから撤去した**。当該 Server Action
 * `generateEffectComment` は `PUBLISHER_ROLES` (school_admin / teacher) を要し school_id 必須のため、
 * system_admin 専用化した本ページでは未捕捉の ForbiddenError になる + system_admin は school_id を
 * 持たず空集計で意味が無い。全校横断の効果可視化は `/ops/dashboard` で運営に提供する。
 *
 * **アクセシビリティ (NFR05 / WCAG 2.2 AA)**: 数値は文字ラベル付きで提示し、色のみに依存しない。
 * ランキングは `<table>` + `<th scope>`、時系列バーも各行に件数テキストを併記して読み上げ可能にする。
 */
export default async function DashboardPage() {
  await requireRole(SYSTEM_ADMIN_ROLES);
  // 同一 RLS context (1 tx) で全クエリを実行する。
  const { stats, daily, hourly, presence, dailyPresence, presenceHeatmap } = await withSession(
    async (tx) => ({
      stats: await getEventStats(tx),
      daily: await getDailyEventCounts(tx),
      hourly: await getHourlyEventCounts(tx),
      presence: await getHourlyPresenceCounts(tx),
      dailyPresence: await getDailyPresenceCounts(tx),
      presenceHeatmap: await getPresenceQuarterHourHeatmap(tx),
    }),
  );

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

      <h2 style={sectionTitleStyle}>日次の在室 (人感センサー)</h2>
      <DailyPresenceTrend dailyPresence={dailyPresence} />

      <h2 style={sectionTitleStyle}>在室ヒートマップ (15 分 × 平日/休日)</h2>
      <PresenceHeatmap heatmap={presenceHeatmap} />

      {/* AI 効果コメント (EffectCommentPanel) は school 専用機能のため system_admin 専用化に伴い撤去
          (docstring 参照)。全校横断の効果可視化は /ops/dashboard で運営に提供する。 */}

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
 * 日次 (JST 暦日) の **在室 (presence)** を CSS バーで軽量描画する。日次の view/tap 推移 (`DailyTrend`)
 * の在室版で、来場の増減トレンドを示す。色のみに依存せず各行に日付ラベルと在室件数テキストを併記
 * (WCAG 2.2 AA、NFR05)。バー色は在室なので緑 (`PresenceTrend` と統一、ADR-020 PIR・カメラ非使用)。
 */
function DailyPresenceTrend({ dailyPresence }: { dailyPresence: DailyPresenceCount[] }) {
  if (dailyPresence.length === 0) {
    return <p style={emptyStyle}>対象期間の在室推移データはまだありません。</p>;
  }
  const max = Math.max(...dailyPresence.map((d) => d.presence), 1);
  return (
    <ul style={trendListStyle}>
      {dailyPresence.map((d) => (
        <li key={d.day} style={trendRowStyle}>
          <span style={trendDayStyle}>{formatDay(d.day)}</span>
          <span style={trendBarTrackStyle}>
            <span style={{ ...presenceBarFillStyle, width: `${(d.presence / max) * 100}%` }} />
          </span>
          <span style={trendCountStyle}>在室 {d.presence}</span>
        </li>
      ))}
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

/**
 * 在室 (presence) を **15 分バケット × 平日/休日**でヒートマップ描画する (F08 受け入れ条件)。時間帯別
 * (`PresenceTrend`, 1 時間粒度) では潰れる「登校直後の山」「昼休みの谷」や平日/休日差を 15 分粒度で
 * 見せる。平日・休日を 2 枚の表に分け、各表は 24 行 (時) × 4 列 (:00/:15/:30/:45)。セル背景は在室件数に
 * 比例した緑の濃淡だが、**色のみに依存せず各セルに件数を併記** + `title` で時刻と件数を補足する
 * (WCAG 2.2 AA / NFR05)。緑は ADR-020 (PIR・カメラ非使用、上部バッジ) と整合。
 */
function PresenceHeatmap({ heatmap }: { heatmap: PresenceHeatmapCell[] }) {
  if (!hasPresenceHeatmapData(heatmap)) {
    return <p style={emptyStyle}>対象期間の在室ヒートマップデータはまだありません。</p>;
  }
  const dense = densifyPresenceHeatmap(heatmap);
  // 平日/休日を同一スケールで比べられるよう、両者通しの最大値で正規化する。
  const max = Math.max(...dense.weekday, ...dense.weekend, 1);
  return (
    <div style={heatmapWrapStyle}>
      <HeatmapGrid title="平日 (月〜金)" buckets={dense.weekday} max={max} />
      <HeatmapGrid title="休日 (土・日)" buckets={dense.weekend} max={max} />
    </div>
  );
}

/** 在室件数 (0〜max) を緑の濃淡にする。色は補助で、件数テキストを併記するため色のみ依存ではない。 */
function heatCellColor(count: number, max: number): string {
  if (count <= 0) {
    return "#f9fafb";
  }
  const t = Math.min(count / max, 1);
  // 薄→濃を alpha で表現。toFixed で SSR/CSR の文字列を一致させる (hydration 差分回避)。
  const alpha = (0.18 + 0.82 * t).toFixed(3);
  return `rgba(16, 185, 129, ${alpha})`;
}

// ヒートマップ表の行 (時 0-23) と列 (15 分の 4 区分)。値配列を map して安定キー (時/バケット番号) を
// 使う (React の配列 index キーを避ける、noArrayIndexKey)。
const HOURS_OF_DAY = Array.from({ length: 24 }, (_, i) => i);
const QUARTERS = [0, 1, 2, 3];

/** 平日 or 休日の 1 枚分のヒートマップ表 (24 行 × 4 列 = 96 バケット)。 */
function HeatmapGrid({ title, buckets, max }: { title: string; buckets: number[]; max: number }) {
  return (
    <figure style={heatmapFigureStyle}>
      <figcaption style={heatmapCaptionStyle}>{title}</figcaption>
      <table style={heatmapTableStyle}>
        <thead>
          <tr>
            <th scope="col" style={heatmapCornerThStyle}>
              時
            </th>
            {["00", "15", "30", "45"].map((m) => (
              <th key={m} scope="col" style={heatmapColThStyle}>
                :{m}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {HOURS_OF_DAY.map((hour) => (
            <tr key={hour}>
              <th scope="row" style={heatmapRowThStyle}>
                {formatHour(hour)}
              </th>
              {QUARTERS.map((q) => {
                const bucket = hour * 4 + q;
                const count = buckets[bucket] ?? 0;
                return (
                  <td
                    key={bucket}
                    style={{ ...heatmapCellStyle, background: heatCellColor(count, max) }}
                    title={`${formatBucket(bucket)} 在室 ${count}`}
                  >
                    {count > 0 ? count : ""}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
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
// 在室ヒートマップ: 平日/休日 2 枚を横並び (狭幅で折り返し)。各表は時(行)×15分(列)の濃淡セル。
const heatmapWrapStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "1.5rem",
  alignItems: "flex-start",
};
const heatmapFigureStyle: React.CSSProperties = { margin: 0 };
const heatmapCaptionStyle: React.CSSProperties = {
  fontSize: "0.85rem",
  fontWeight: 600,
  color: "#374151",
  marginBottom: "0.4rem",
};
const heatmapTableStyle: React.CSSProperties = {
  borderCollapse: "collapse",
  fontSize: "0.7rem",
  fontVariantNumeric: "tabular-nums",
};
const heatmapCornerThStyle: React.CSSProperties = {
  padding: "0.15rem 0.3rem",
  color: "#6b7280",
  fontWeight: 600,
  textAlign: "right",
};
const heatmapColThStyle: React.CSSProperties = {
  padding: "0.15rem 0.25rem",
  color: "#6b7280",
  fontWeight: 600,
  textAlign: "center",
  width: "2.1rem",
};
const heatmapRowThStyle: React.CSSProperties = {
  padding: "0.1rem 0.3rem",
  color: "#6b7280",
  fontWeight: 500,
  textAlign: "right",
  whiteSpace: "nowrap",
};
const heatmapCellStyle: React.CSSProperties = {
  padding: "0.1rem",
  textAlign: "center",
  color: "#064e3b",
  border: "1px solid #f3f4f6",
  minWidth: "2.1rem",
  height: "1.1rem",
};
