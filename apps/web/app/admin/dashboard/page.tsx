import { requireRole } from "@/lib/auth/guard";
import { PUBLISHER_ROLES } from "@/lib/contents/publish-core";
import { withSession } from "@/lib/db";
import { getEventStats } from "@kimiterrace/db";

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
 * `withSession` で RLS context を張り `getEventStats` で集計する (school 境界は RLS が DB レベルで
 * 強制、CLAUDE.md ルール2)。本スライスは数値サマリ + content 別ランキング表のみ。グラフ
 * (Recharts/Visx)・人感センサーヒートマップ・AI 効果コメントは後続スライスで追加する (依存追加を
 * 避け、まず集計の正しさと導線を確立する)。
 *
 * **アクセシビリティ (NFR05 / WCAG 2.2 AA)**: 数値は文字ラベル付きで提示し、色のみに依存しない。
 * ランキングは `<table>` + `<th scope>` の意味付き構造で読み上げ可能にする。
 */
export default async function DashboardPage() {
  await requireRole(PUBLISHER_ROLES);
  const stats = await withSession((tx) => getEventStats(tx));

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
        <SummaryCard label="表示 (view)" value={stats.totals.view} />
        <SummaryCard label="タップ (tap)" value={stats.totals.tap} />
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
