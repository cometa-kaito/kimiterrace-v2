import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { SYSTEM_ADMIN_ROLES } from "@/lib/system-admin/roles";
import {
  currentJstYearMonth,
  formatYearMonth,
  isAfterMonth,
  isSameMonth,
  parseYearMonth,
  shiftMonth,
  toYmParam,
} from "@/lib/reports/month";
import { getMonthlyAdReach, getMonthlySchoolSummary } from "@kimiterrace/db";

/**
 * F09 (#45): 月次レポート 第1スライス — **学校別サマリー** (`/admin/reports`)。**Server Component**。
 *
 * F07 (#43) が `events` に記録した行動ログを **JST 暦月**で集計し、教員向けに自校サイネージの活動
 * サマリー (view/tap/ask 総数・稼働日数・コンテンツ別ランキング) を 1 枚で見せる (F09 受け入れ条件
 * 「学校別レポート: 教員向け、サイネージ全体の活動サマリー」)。
 *
 * **認可 (校務DX原則: 監視系は運営専用)**: 月次レポートは「自校の運営を見る」閲覧系で、先生・校長の
 * 校務を楽にする機能ではない。`/admin` レイアウトの `requireRole(ADMIN_ROLES)` に加え、本ページは
 * `requireRole(SYSTEM_ADMIN_ROLES)` (system_admin のみ) に締める。teacher / school_admin は nav から
 * 撤去済み + ここで 403 (`/forbidden`)。全校横断の月次レポート履歴 / PDF ダウンロードは
 * `/admin/system/reports` で運営に提供する。
 *
 * 注: 本ページの集計 (`getMonthlySchoolSummary` 等) は school_id スコープ前提だが、system_admin は
 * school_id を持たず通常 nav からは到達しない (撤去済)。URL 直打ちの system_admin に対しては RLS の
 * `system_admin_full_access` policy 下で集計が走り (空表示で落ちはしない)、実害は無い。
 *
 * **広告別 到達数 (#322 / ADR-025)**: 学校別サマリーの「延べ表示数 (engagement)」とは別に、広告ごとの
 * **到達数 (reach)** を `getMonthlyAdReach` (`(client_id, ad_id, JST 分)` で集計時 minute-dedup) で当月分
 * 表示する。延べ件数を到達数として出さない。広告ラベルは `ads.caption`、件数のみで匿名 clientId は出さない
 * (ルール4)。広告は CRM の advertiser アカウントと未リンクのため現状は **広告 (caption) 単位**で集計する。
 *
 * `withSession` で RLS context を張り集計する (school 境界は RLS が DB レベルで強制、ルール2)。
 * 対象月は `?ym=YYYY-MM` で指定し、未指定なら現在の JST 暦月。前後月リンクで遷移でき、未来月へは
 * 進めない (データが存在しないため翌月リンクは現在月で打ち止め)。
 *
 * **アクセシビリティ (NFR05 / WCAG 2.2 AA)**: 数値は文字ラベル付きで提示し色のみに依存しない。
 * ランキングは `<table>` + `<th scope>`、月ナビは `<nav>` + リンクテキストで読み上げ可能にする。
 */
export default async function MonthlyReportPage({
  searchParams,
}: {
  searchParams: Promise<{ ym?: string }>;
}) {
  await requireRole(SYSTEM_ADMIN_ROLES);

  const current = currentJstYearMonth();
  // ?ym=YYYY-MM を検証。不正・未指定・未来月は現在の JST 暦月に丸める (未来はデータ不在のため)。
  const requested = parseYearMonth((await searchParams).ym);
  const target = requested && !isAfterMonth(requested, current) ? requested : current;

  const summary = await withSession(
    (tx) => getMonthlySchoolSummary(tx, { year: target.year, month: target.month }),
    { allowedRoles: SYSTEM_ADMIN_ROLES },
  );
  // 広告別 到達数 (reach、minute-dedup)。延べ表示数 (engagement) とは別指標 (#322 / ADR-025)。
  const adReach = await withSession(
    (tx) => getMonthlyAdReach(tx, { year: target.year, month: target.month }),
    { allowedRoles: SYSTEM_ADMIN_ROLES },
  );

  const prev = shiftMonth(target, -1);
  const next = shiftMonth(target, +1);
  // 翌月リンクは「現在月より前のときだけ」有効 (未来月はデータ不在で打ち止め)。
  const hasNext = !isSameMonth(target, current);

  return (
    <section>
      <div style={headerStyle}>
        <h1 style={titleStyle}>月次レポート</h1>
        {/* ADR-020 公開透明性: 来場検知は PIR センサーでカメラ非使用。常時バッジで明示する。 */}
        <span
          style={cameraBadgeStyle}
          title="来場検知は人感(PIR)センサーのみ。カメラ・録画は使用しません。"
        >
          カメラ不使用
        </span>
      </div>
      <p style={subtitleStyle}>自校サイネージの月別 活動サマリー (教員向け)</p>

      <nav style={monthNavStyle} aria-label="対象月の切り替え">
        <a style={navLinkStyle} href={`?ym=${toYmParam(prev)}`} rel="prev">
          ← {formatYearMonth(prev)}
        </a>
        <span style={monthLabelStyle} aria-current="date">
          {formatYearMonth(target)}
        </span>
        {hasNext ? (
          <a style={navLinkStyle} href={`?ym=${toYmParam(next)}`} rel="next">
            {formatYearMonth(next)} →
          </a>
        ) : (
          <span style={navLinkDisabledStyle} aria-disabled="true">
            {formatYearMonth(next)} →
          </span>
        )}
      </nav>

      {/* CSV ダウンロード (第2スライス): 画面と同じ集計を text/csv で持ち帰る。対象月を引き継ぐ。 */}
      <p style={downloadRowStyle}>
        <a style={downloadLinkStyle} href={`/api/reports/monthly?ym=${toYmParam(target)}`} download>
          ⬇ {formatYearMonth(target)}のサマリーを CSV でダウンロード
        </a>
      </p>

      <div style={cardsStyle}>
        <SummaryCard label="延べ表示数 (engagement)" value={summary.totals.view} />
        <SummaryCard label="タップ (tap)" value={summary.totals.tap} />
        <SummaryCard label="Q&A (ask)" value={summary.totals.ask} />
        <SummaryCard label="稼働日数" value={summary.activeDays} unit="日" />
      </div>

      <h2 style={sectionTitleStyle}>反応が多かったコンテンツ</h2>
      {summary.ranking.length === 0 ? (
        <p style={emptyStyle}>この月の反応データはまだありません。</p>
      ) : (
        <table style={tableStyle}>
          <caption style={captionStyle}>反応 (表示+タップ) が多い順のコンテンツ一覧</caption>
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
            {summary.ranking.map((row) => (
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

      <h2 style={sectionTitleStyle}>広告別 到達数 (reach)</h2>
      {adReach.length === 0 ? (
        <p style={emptyStyle}>この月の広告到達データはまだありません。</p>
      ) : (
        <table style={tableStyle}>
          <caption style={captionStyle}>
            広告ごとの到達数 (重複排除済)。同じ端末が同じ広告を同一分内に複数回見ても 1 と数えます。
          </caption>
          <thead>
            <tr>
              <th scope="col" style={thLeftStyle}>
                広告
              </th>
              <th scope="col" style={thNumStyle}>
                到達数 (reach)
              </th>
            </tr>
          </thead>
          <tbody>
            {adReach.map((a) => (
              <tr key={a.adId}>
                <th scope="row" style={tdLeftStyle}>
                  {a.caption ?? "（無題の広告）"}
                </th>
                <td style={tdNumTotalStyle}>{a.reach.toLocaleString("ja-JP")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p style={footnoteStyle}>
        集計は日本時間 (JST) の暦月基準です。「延べ表示数
        (engagement)」は表示の延べ回数で、同じ内容を複数回・複数端末で表示した分も数えます。「到達数
        (reach)」は広告ごとに (端末, 分) 単位で重複排除した指標で、表示枚数やローテーション速度では
        水増しされません (ADR-025)。学校別サマリーは上のリンクから CSV
        でダウンロードできます。広告別 到達数の CSV / PDF
        と広告主アカウント単位の集計は今後のスライスで追加します。
      </p>
    </section>
  );
}

function SummaryCard({ label, value, unit }: { label: string; value: number; unit?: string }) {
  return (
    <div style={cardStyle}>
      <span style={cardLabelStyle}>{label}</span>
      <span style={cardValueStyle}>
        {value.toLocaleString("ja-JP")}
        {unit ? <span style={cardUnitStyle}>{unit}</span> : null}
      </span>
    </div>
  );
}

const headerStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: "0.75rem" };
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
const subtitleStyle: React.CSSProperties = { color: "#6b7280", margin: "0.35rem 0 1rem" };
const monthNavStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "1rem",
  marginBottom: "1.25rem",
};
const navLinkStyle: React.CSSProperties = {
  color: "#2563eb",
  textDecoration: "none",
  fontSize: "0.9rem",
  fontWeight: 600,
};
const navLinkDisabledStyle: React.CSSProperties = {
  color: "#d1d5db",
  fontSize: "0.9rem",
  fontWeight: 600,
  cursor: "default",
};
const monthLabelStyle: React.CSSProperties = {
  fontSize: "1.05rem",
  fontWeight: 700,
  minWidth: "8rem",
  textAlign: "center",
};
const downloadRowStyle: React.CSSProperties = { margin: "0 0 1.25rem" };
const downloadLinkStyle: React.CSSProperties = {
  display: "inline-block",
  color: "#2563eb",
  textDecoration: "none",
  fontSize: "0.85rem",
  fontWeight: 600,
  border: "1px solid #bfdbfe",
  borderRadius: "8px",
  padding: "0.4rem 0.8rem",
};
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
const cardUnitStyle: React.CSSProperties = {
  fontSize: "0.9rem",
  fontWeight: 600,
  marginLeft: "0.2rem",
  color: "#6b7280",
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
const footnoteStyle: React.CSSProperties = {
  color: "#9ca3af",
  fontSize: "0.8rem",
  marginTop: "1.5rem",
};
