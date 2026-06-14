import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { FEEDBACK_SORT_KEYS, listFeedbackPage } from "@/lib/system-admin/feedback-list";
import { SYSTEM_ADMIN_ROLES } from "@/lib/system-admin/roles";
import { tokens } from "@kimiterrace/ui";
import { DataListControls } from "../../_components/datalist/DataListControls";
import { DataTable } from "../../_components/datalist/DataTable";
import { PaginationNav } from "../../_components/datalist/PaginationNav";
import { type RawSearchParams, parseListParams } from "../../_components/datalist/list-params";

const { color, fontSize, radius, space } = tokens;

const BASE_PATH = "/ops/feedback";

/** スコアフィルタ (1-5) の選択肢。feedback-list.ts の SCORE_RE と同じ値域。 */
const SCORE_OPTIONS = ["5", "4", "3", "2", "1"].map((v) => ({ value: v, label: `${v} / 5` }));

/**
 * F12 (#48-M) / UIUX-03: システム管理者の フィードバック一覧 (`/ops/feedback`)。
 * **Server Component**。
 *
 * UIUX-03 で共通 DataList 基盤 (検索 / 列ソート / スコアフィルタ / 受付日範囲 / ページング) を
 * 適用 — データ取得は `listFeedbackPage` (apps/web/lib) がサーバーサイドで絞り込み、全件スキャン
 * をやめる。
 *
 * **認可 (system_admin 限定)**: `/admin` レイアウトの認可に加え、本ページは
 * `requireRole(SYSTEM_ADMIN_ROLES)` で system_admin 以外を 403 (`/forbidden`)。フィードバックは
 * cross-tenant で PII を含みうるため、school_admin / teacher には見せない。
 *
 * **横断 RLS (ADR-019 / ルール2)**: system_admin は schoolId=null で `withSession` に入り、
 * `app.current_user_role='system_admin'` のみ SET される。feedback の `system_admin_only` policy が
 * 全件 SELECT を grant するため、クエリ層は role の `WHERE` を**書かない** — 可視範囲は RLS に
 * 委ねる。万一非 system_admin がここを通っても (実際は 403) RLS が 0 件に倒す (多層防御)。
 *
 * **PII (ルール4)**: studentEpisode 等を表示するが、本ページは system_admin のみ到達でき、LLM には
 * 一切渡さない (表示のみ)。
 */
export default async function SystemFeedbackPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  await requireRole(SYSTEM_ADMIN_ROLES);
  const params = parseListParams(await searchParams, {
    sortKeys: FEEDBACK_SORT_KEYS,
    defaultSort: "submittedAt",
    defaultDir: "desc",
    filterKeys: ["reaction", "utility"],
  });
  const { rows, total } = await withSession((tx) => listFeedbackPage(tx, params));

  const hasCondition =
    params.q !== "" ||
    params.from != null ||
    params.to != null ||
    Object.keys(params.filters).length > 0;

  return (
    <section>
      <header style={headerStyle}>
        <h1 style={titleStyle}>フィードバック</h1>
        <span style={countStyle}>{total} 件</span>
      </header>

      <DataListControls
        basePath={BASE_PATH}
        params={params}
        searchPlaceholder="学校名・クラス・本文"
        selects={[
          { name: "reaction", label: "生徒の反応・注目度", options: SCORE_OPTIONS },
          { name: "utility", label: "先生の業務負担・利便性", options: SCORE_OPTIONS },
        ]}
        dateRange
        dateRangeLabel="受付日"
      />

      <DataTable
        basePath={BASE_PATH}
        params={params}
        empty={
          hasCondition
            ? "条件に合うフィードバックがありません。"
            : "まだフィードバックがありません。"
        }
        columns={[
          { key: "submittedAt", label: "受付日時", sortable: true },
          { key: "schoolName", label: "学校", sortable: true },
          { key: "classroomLabel", label: "クラス", sortable: true },
          { key: "studentReaction", label: "生徒の反応・注目度", sortable: true, align: "right" },
          {
            key: "teacherUtility",
            label: "先生の業務負担・利便性",
            sortable: true,
            align: "right",
          },
          { key: "body", label: "内容" },
        ]}
        rows={rows.map((f) => ({
          key: f.id,
          cells: [
            <span key="submittedAt" style={dateStyle}>
              {formatJst(f.submittedAt)}
            </span>,
            <span key="schoolName" style={schoolStyle}>
              {f.schoolName ?? "（学校名なし）"}
            </span>,
            f.classroomLabel ? (
              <span key="classroomLabel" style={classStyle}>
                {f.classroomLabel}
              </span>
            ) : (
              "—"
            ),
            <span key="studentReaction" style={scoreStyle}>
              {f.studentReaction}/5
            </span>,
            <span key="teacherUtility" style={scoreStyle}>
              {f.teacherUtility}/5
            </span>,
            <span key="body">
              {f.studentEpisode ? (
                <span style={blockStyle}>
                  <span style={blockLabelStyle}>具体的なエピソード</span>
                  <span style={blockBodyStyle}>{f.studentEpisode}</span>
                </span>
              ) : null}
              {f.improvement ? (
                <span style={blockStyle}>
                  <span style={blockLabelStyle}>改善のご要望・お気付きの点</span>
                  <span style={blockBodyStyle}>{f.improvement}</span>
                </span>
              ) : null}
              {!f.studentEpisode && !f.improvement ? "—" : null}
            </span>,
          ],
        }))}
      />

      <PaginationNav basePath={BASE_PATH} params={params} total={total} />
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
  marginBottom: space.md,
};
const titleStyle: React.CSSProperties = { fontSize: "1.3rem", fontWeight: 700 };
const countStyle: React.CSSProperties = { fontSize: fontSize.sm, color: color.muted };
const dateStyle: React.CSSProperties = { color: color.muted, whiteSpace: "nowrap" };
const schoolStyle: React.CSSProperties = { fontWeight: 700 };
const classStyle: React.CSSProperties = {
  fontSize: fontSize.xs,
  color: color.neutralFg,
  background: color.neutralBg,
  borderRadius: radius.sm,
  padding: "0.1rem 0.4rem",
  whiteSpace: "nowrap",
};
const scoreStyle: React.CSSProperties = {
  fontSize: fontSize.sm,
  color: color.infoFg,
  fontWeight: 600,
  whiteSpace: "nowrap",
};
const blockStyle: React.CSSProperties = {
  display: "block",
  marginBottom: space.sm,
  maxWidth: "32rem",
};
const blockLabelStyle: React.CSSProperties = {
  display: "block",
  fontSize: fontSize.xs,
  color: color.muted,
  fontWeight: 600,
};
const blockBodyStyle: React.CSSProperties = {
  display: "block",
  fontSize: fontSize.md,
  whiteSpace: "pre-wrap",
  margin: "0.15rem 0 0",
  lineHeight: 1.6,
};
