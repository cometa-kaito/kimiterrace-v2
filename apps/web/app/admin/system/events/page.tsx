import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import {
  EVENT_SORT_KEYS,
  EVENT_TYPES,
  type EventType,
  listEventLogPage,
  parseEventTypeFilter,
  parseSchoolFilter,
} from "@/lib/system-admin/event-log";
import { formatMaskedJson } from "@/lib/system-admin/mask";
import { SYSTEM_ADMIN_ROLES } from "@/lib/system-admin/roles";
import { writeViewAccessAudit } from "@/lib/system-admin/view-audit";
import { listSchools } from "@kimiterrace/db";
import { tokens } from "@kimiterrace/ui";
import { DataListControls } from "../../_components/datalist/DataListControls";
import { DataTable } from "../../_components/datalist/DataTable";
import { PaginationNav } from "../../_components/datalist/PaginationNav";
import { type RawSearchParams, parseListParams } from "../../_components/datalist/list-params";

/**
 * 描画ごとに閲覧監査 (`writeViewAccessAudit`) を書き込む副作用を持つため、静的化・キャッシュを
 * 禁止する (監査の抜け = NFR04 違反)。データも firehose で常に最新を出す。
 */
export const dynamic = "force-dynamic";

const { color, fontSize, radius, space } = tokens;

/** イベント種別の表示ラベル (生値と併記)。enum 値を網羅 (型でズレ検出、ルール3)。 */
const EVENT_TYPE_LABEL: Record<EventType, string> = {
  view: "表示",
  tap: "タップ",
  dwell: "滞在",
  ask: "質問",
  presence: "来場検知",
};

const BASE_PATH = "/admin/system/events";

/**
 * UIUX-03: システム管理者の events 生ログビューア (`/admin/system/events`)。**Server Component**。
 *
 * view/tap/dwell/ask/presence の firehose を全校横断で閲覧する調査用ページ。共通 DataList 基盤
 * (フリーワード / 種別 / 学校 / 発生日範囲 / 列ソート / ページング) を適用し、データ取得は
 * `listEventLogPage` (apps/web/lib) がサーバーサイドで絞り込む。
 *
 * - **認可**: `requireRole(SYSTEM_ADMIN_ROLES)` (system_admin のみ)。可視範囲は RLS
 *   (`system_admin_full_access`) に委譲し、学校セレクトは検索条件 (ルール2、event-log.ts 参照)。
 * - **閲覧監査 (ルール1 / NFR04)**: 描画ごとに `writeViewAccessAudit` で「誰が・どの絞り込みで・
 *   何件見たか」を audit_log へ append する (データ取得と同一 `withSession` tx 内)。
 * - **PII (ルール4)**: payload は必ず `formatMaskedJson` (識別子マスク + 切り詰め) を通して表示し、
 *   生 jsonb をそのまま出さない。**raw export / CSV は提供しない** — 持出は type 別集計サマリ
 *   (テーブル上部チップ) まで。
 */
export default async function SystemEventsPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  await requireRole(SYSTEM_ADMIN_ROLES);
  const params = parseListParams(await searchParams, {
    sortKeys: EVENT_SORT_KEYS,
    defaultSort: "occurredAt",
    defaultDir: "desc",
    filterKeys: ["type", "school"],
  });

  const { rows, total, typeCounts, schoolOptions } = await withSession(async (tx, user) => {
    const [page, allSchools] = await Promise.all([listEventLogPage(tx, params), listSchools(tx)]);
    // 閲覧監査はデータ取得と同一 tx 内で await する (描画されたのに監査が無い、を作らない)。
    // detail は実際に効いた検証済みフィルタ + page/total のみ (閲覧された行の中身 = PII は載せない)。
    await writeViewAccessAudit(tx, user, {
      subject: "events_view_access",
      schoolId: parseSchoolFilter(params.filters.school),
      detail: {
        q: params.q,
        type: parseEventTypeFilter(params.filters.type),
        school: parseSchoolFilter(params.filters.school),
        from: params.from,
        to: params.to,
        page: params.page,
        total: page.total,
      },
    });
    return { ...page, schoolOptions: allSchools };
  });

  return (
    <section>
      <header style={headerStyle}>
        <h1 style={titleStyle}>イベントログ</h1>
        <span style={countStyle}>{total.toLocaleString("ja-JP")} 件</span>
      </header>
      <p style={subtitleStyle}>
        生イベントログ（全校横断）。閲覧操作は監査ログに記録されます。エクスポートは集計のみ（生ログの一括持出不可）。
      </p>

      {/* type 別集計サマリ (現在のフィルタ条件と同一 WHERE)。「エクスポートは集計のみ」方針の代替。 */}
      <div style={summaryRowStyle}>
        {EVENT_TYPES.map((t) => (
          <span key={t} style={summaryChipStyle}>
            <span style={summaryLabelStyle}>{EVENT_TYPE_LABEL[t]}</span>
            <strong style={summaryCountStyle}>{typeCounts[t].toLocaleString("ja-JP")}</strong>
          </span>
        ))}
      </div>

      <DataListControls
        basePath={BASE_PATH}
        params={params}
        searchPlaceholder="ペイロード・コンテンツ名"
        selects={[
          {
            name: "type",
            label: "種別",
            options: EVENT_TYPES.map((t) => ({ value: t, label: EVENT_TYPE_LABEL[t] })),
          },
          {
            name: "school",
            label: "学校",
            options: schoolOptions.map((s) => ({
              value: s.id,
              label: `${s.name}（${s.prefecture}）`,
            })),
          },
        ]}
        dateRange
        dateRangeLabel="発生日"
      />

      <DataTable
        basePath={BASE_PATH}
        params={params}
        empty="条件に合うイベントがありません。"
        columns={[
          { key: "occurredAt", label: "発生日時", sortable: true },
          { key: "type", label: "種別", sortable: true },
          { key: "schoolName", label: "学校", sortable: true },
          { key: "contentTitle", label: "コンテンツ" },
          { key: "payload", label: "ペイロード（マスク済み）" },
        ]}
        rows={rows.map((e) => ({
          key: e.id,
          cells: [
            <span key="at" style={timeCellStyle}>
              {formatJstDateTime(e.occurredAt)}
            </span>,
            <span key="type" style={typeCellStyle}>
              {EVENT_TYPE_LABEL[e.type]}
              <span style={typeRawStyle}>{e.type}</span>
            </span>,
            e.schoolName,
            e.contentTitle ?? "—",
            <code key="payload" style={payloadStyle}>
              {formatMaskedJson(e.payload)}
            </code>,
          ],
        }))}
      />

      <PaginationNav basePath={BASE_PATH} params={params} total={total} />
    </section>
  );
}

/** occurredAt を JST の YYYY/MM/DD HH:mm:ss で表示する (サーバー描画、ロケール非依存に固定)。 */
function formatJstDateTime(value: Date): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(value);
}

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  marginBottom: space.sm,
};
const titleStyle: React.CSSProperties = { fontSize: "1.3rem", fontWeight: 700, margin: 0 };
const countStyle: React.CSSProperties = { fontSize: fontSize.sm, color: color.muted };
const subtitleStyle: React.CSSProperties = { color: color.muted, margin: `0 0 ${space.lg}` };
const summaryRowStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: space.sm,
  marginBottom: space.md,
};
const summaryChipStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "baseline",
  gap: space.sm,
  padding: `0.3rem ${space.md}`,
  background: color.neutralBg,
  border: `1px solid ${color.neutralBorder}`,
  borderRadius: radius.pill,
};
const summaryLabelStyle: React.CSSProperties = { fontSize: fontSize.xs, color: color.muted };
const summaryCountStyle: React.CSSProperties = { fontSize: fontSize.sm, color: color.ink };
const timeCellStyle: React.CSSProperties = { whiteSpace: "nowrap" };
const typeCellStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "baseline",
  gap: space.xs,
  whiteSpace: "nowrap",
};
const typeRawStyle: React.CSSProperties = { fontSize: fontSize.xs, color: color.muted };
const payloadStyle: React.CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  fontSize: fontSize.xs,
  color: color.ink,
  display: "inline-block",
  maxWidth: "26rem",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  verticalAlign: "bottom",
};
