import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { SYSTEM_ADMIN_ROLES } from "@/lib/system-admin/roles";
import { getEventStatsBySchool } from "@kimiterrace/db";

/**
 * F08 (#44) 第4スライス: システム管理者の **全校横断ダッシュボード** (`/admin/system/dashboard`)。
 * **Server Component**。
 *
 * F08 第1〜3スライス (`/admin/dashboard`) が school_admin / teacher の**自校**ビューを担うのに対し、
 * 本ページは運営 (system_admin) が全校の活動量を横断で把握するための**学校別サマリー**を提供する。
 *
 * **認可**: `/admin` レイアウトの `requireRole(ADMIN_ROLES)` に加え `requireRole(SYSTEM_ADMIN_ROLES)`
 * (system_admin のみ)。school_admin / teacher は 403 (`/forbidden`)。横断データを自校ビューに混ぜない
 * (#166 / F08 第1スライスと同方針)。実データの越境は `getEventStatsBySchool` が委譲する events /
 * schools の RLS (`system_admin_full_access`、ADR-019) が DB レベルで強制する (CLAUDE.md ルール2、多層防御)。
 *
 * `withSession` で RLS context を張り集計する。集計は件数のみで `events.payload` の匿名 clientId は
 * 読まない (ルール4)。重い描画ライブラリは導入しない。
 *
 * **アクセシビリティ (NFR05 / WCAG 2.2 AA)**: 学校別サマリーは `<table>` + `<th scope>` で提示し、
 * 数値は文字ラベル付きで色のみに依存しない。
 */
export default async function SystemDashboardPage() {
  await requireRole(SYSTEM_ADMIN_ROLES);
  const schools = await withSession((tx) => getEventStatsBySchool(tx));

  // 全校合算 (ヘッダのサマリーカード用)。
  const overall = schools.reduce(
    (acc, s) => ({
      view: acc.view + s.totals.view,
      tap: acc.tap + s.totals.tap,
      ask: acc.ask + s.totals.ask,
    }),
    { view: 0, tap: 0, ask: 0 },
  );
  const sinceDays = 30;

  return (
    <section>
      <div style={headerStyle}>
        <h1 style={titleStyle}>全校ダッシュボード</h1>
        {/* ADR-020 公開透明性: 来場検知は PIR センサーでカメラ非使用。常時バッジで明示する。 */}
        <span
          style={cameraBadgeStyle}
          title="来場検知は人感(PIR)センサーのみ。カメラ・録画は使用しません。"
        >
          カメラ不使用
        </span>
      </div>
      <p style={subtitleStyle}>
        過去 {sinceDays} 日間・全校横断の反応（活動のあった {schools.length} 校）
      </p>

      <div style={cardsStyle}>
        <SummaryCard label="表示 (view)" value={overall.view} />
        <SummaryCard label="タップ (tap)" value={overall.tap} />
        <SummaryCard label="Q&A (ask)" value={overall.ask} />
      </div>

      <h2 style={sectionTitleStyle}>学校別の反応</h2>
      {schools.length === 0 ? (
        <p style={emptyStyle}>対象期間に活動のあった学校はまだありません。</p>
      ) : (
        <table style={tableStyle}>
          <caption style={captionStyle}>反応 (表示+タップ) が多い順の学校一覧</caption>
          <thead>
            <tr>
              <th scope="col" style={thLeftStyle}>
                学校
              </th>
              <th scope="col" style={thLeftNarrowStyle}>
                都道府県
              </th>
              <th scope="col" style={thNumStyle}>
                表示
              </th>
              <th scope="col" style={thNumStyle}>
                タップ
              </th>
              <th scope="col" style={thNumStyle}>
                Q&A
              </th>
              <th scope="col" style={thNumStyle}>
                反応計
              </th>
            </tr>
          </thead>
          <tbody>
            {schools.map((s) => (
              <tr key={s.schoolId}>
                <th scope="row" style={tdLeftStyle}>
                  {s.schoolName}
                </th>
                <td style={tdLeftNarrowStyle}>{s.prefecture}</td>
                <td style={tdNumStyle}>{s.totals.view.toLocaleString("ja-JP")}</td>
                <td style={tdNumStyle}>{s.totals.tap.toLocaleString("ja-JP")}</td>
                <td style={tdNumStyle}>{s.totals.ask.toLocaleString("ja-JP")}</td>
                <td style={tdNumTotalStyle}>{s.reactions.toLocaleString("ja-JP")}</td>
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
const thLeftNarrowStyle: React.CSSProperties = { ...thLeftStyle, width: "7rem" };
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
const tdLeftNarrowStyle: React.CSSProperties = {
  ...tdLeftStyle,
  fontWeight: 400,
  color: "#6b7280",
};
const tdNumStyle: React.CSSProperties = {
  textAlign: "right",
  padding: "0.5rem 0.6rem",
  borderBottom: "1px solid #f3f4f6",
  fontVariantNumeric: "tabular-nums",
};
const tdNumTotalStyle: React.CSSProperties = { ...tdNumStyle, fontWeight: 700 };
