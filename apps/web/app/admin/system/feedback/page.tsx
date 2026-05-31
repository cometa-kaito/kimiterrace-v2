import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { SYSTEM_ADMIN_ROLES } from "@/lib/system-admin/roles";
import { listFeedback } from "@kimiterrace/db";

/**
 * F12 (#48-M): システム管理者の フィードバック一覧 (`/admin/system/feedback`)。**Server Component**。
 *
 * **認可 (system_admin 限定)**: `/admin` レイアウトの認可に加え、本ページは
 * `requireRole(SYSTEM_ADMIN_ROLES)` で system_admin 以外を 403 (`/forbidden`)。フィードバックは
 * cross-tenant で PII を含みうるため、school_admin / teacher には見せない。
 *
 * **横断 RLS (ADR-019 / ルール2)**: system_admin は schoolId=null で `withSession` に入り、
 * `app.current_user_role='system_admin'` のみ SET される。feedback の `system_admin_only` policy が
 * 全件 SELECT を grant するため、本ページは `WHERE` を**書かない** — 可視範囲は RLS に委ねる。
 * 万一非 system_admin がここを通っても (実際は 403) RLS が 0 件に倒す (多層防御)。
 *
 * **PII (ルール4)**: studentEpisode 等を表示するが、本ページは system_admin のみ到達でき、LLM には
 * 一切渡さない (表示のみ)。
 */
export default async function SystemFeedbackPage() {
  await requireRole(SYSTEM_ADMIN_ROLES);
  const items = await withSession((tx) => listFeedback(tx));

  return (
    <section>
      <header style={headerStyle}>
        <h1 style={titleStyle}>フィードバック</h1>
        <span style={countStyle}>{items.length} 件</span>
      </header>

      {items.length === 0 ? (
        <p style={emptyStyle}>まだフィードバックがありません。</p>
      ) : (
        <ul style={listStyle}>
          {items.map((f) => (
            <li key={f.id} style={cardStyle}>
              <div style={cardHeadStyle}>
                <span style={schoolStyle}>{f.schoolName ?? "（学校名なし）"}</span>
                {f.classroomLabel ? <span style={classStyle}>{f.classroomLabel}</span> : null}
                <span style={dateStyle}>{formatJst(f.submittedAt)}</span>
              </div>
              <div style={scoreRowStyle}>
                <span style={scoreStyle}>生徒の反応・注目度: {f.studentReaction}/5</span>
                <span style={scoreStyle}>先生の業務負担・利便性: {f.teacherUtility}/5</span>
              </div>
              {f.studentEpisode ? (
                <div style={blockStyle}>
                  <div style={blockLabelStyle}>具体的なエピソード</div>
                  <p style={blockBodyStyle}>{f.studentEpisode}</p>
                </div>
              ) : null}
              {f.improvement ? (
                <div style={blockStyle}>
                  <div style={blockLabelStyle}>改善のご要望・お気付きの点</div>
                  <p style={blockBodyStyle}>{f.improvement}</p>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** submittedAt を JST の YYYY/MM/DD HH:mm で表示する (サーバー描画、ロケール非依存に固定)。 */
function formatJst(value: Date): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  marginBottom: "1rem",
};
const titleStyle: React.CSSProperties = { fontSize: "1.3rem", fontWeight: 700 };
const countStyle: React.CSSProperties = { fontSize: "0.85rem", color: "#6b7280" };
const emptyStyle: React.CSSProperties = { color: "#6b7280" };
const listStyle: React.CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
};
const cardStyle: React.CSSProperties = {
  border: "1px solid #e5e7eb",
  borderRadius: "0.5rem",
  padding: "0.9rem 1rem",
};
const cardHeadStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: "0.75rem",
  flexWrap: "wrap",
};
const schoolStyle: React.CSSProperties = { fontWeight: 700 };
const classStyle: React.CSSProperties = {
  fontSize: "0.8rem",
  color: "#374151",
  background: "#f3f4f6",
  borderRadius: "0.3rem",
  padding: "0.1rem 0.4rem",
};
const dateStyle: React.CSSProperties = { marginLeft: "auto", fontSize: "0.8rem", color: "#9ca3af" };
const scoreRowStyle: React.CSSProperties = {
  display: "flex",
  gap: "1rem",
  flexWrap: "wrap",
  margin: "0.5rem 0",
};
const scoreStyle: React.CSSProperties = { fontSize: "0.85rem", color: "#1d4ed8", fontWeight: 600 };
const blockStyle: React.CSSProperties = { marginTop: "0.5rem" };
const blockLabelStyle: React.CSSProperties = {
  fontSize: "0.78rem",
  color: "#6b7280",
  fontWeight: 600,
};
const blockBodyStyle: React.CSSProperties = {
  fontSize: "0.9rem",
  whiteSpace: "pre-wrap",
  margin: "0.15rem 0 0",
  lineHeight: 1.6,
};
