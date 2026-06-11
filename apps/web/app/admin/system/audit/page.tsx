import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import {
  AUDIT_LOG_SORT_KEYS,
  AUDIT_OPERATION_VALUES,
  type AuditOperation,
  listAuditLogPage,
  listAuditLogTableNames,
} from "@/lib/system-admin/audit-log-list";
import { formatMaskedJson } from "@/lib/system-admin/mask";
import { SYSTEM_ADMIN_ROLES } from "@/lib/system-admin/roles";
import { writeViewAccessAudit } from "@/lib/system-admin/view-audit";
import { tokens } from "@kimiterrace/ui";
import { DataListControls } from "../../_components/datalist/DataListControls";
import { DataTable } from "../../_components/datalist/DataTable";
import { PaginationNav } from "../../_components/datalist/PaginationNav";
import { type RawSearchParams, parseListParams } from "../../_components/datalist/list-params";

const { color, fontSize, space } = tokens;

const BASE_PATH = "/admin/system/audit";

/**
 * 表示ごとに必ずサーバーで描画する (キャッシュ/プリレンダ禁止)。本ページは表示のたびに
 * 閲覧監査 INSERT を伴うため、キャッシュ配信 = 監査の取りこぼしになる。
 */
export const dynamic = "force-dynamic";

/** 操作種別の表示ラベル。enum 値を網羅 (型でズレ検出、ルール3)。 */
const OPERATION_LABEL: Record<AuditOperation, string> = {
  insert: "作成",
  update: "更新",
  delete: "削除",
};

/**
 * UIUX-03: システム管理者の監査ログビューア (`/admin/system/audit`)。**Server Component**。
 *
 * `audit_log` (NFR04: append-only・hash chain) の who / what / when / diff / IP を、共通 DataList
 * 基盤 (検索 / 列ソート / 操作種別・対象テーブルフィルタ / 発生日範囲 / ページング) で一覧する。
 * データ取得は `listAuditLogPage` (apps/web/lib) がサーバーサイドで絞り込む。
 *
 * **認可**: `requireRole(SYSTEM_ADMIN_ROLES)` (system_admin のみ)。可視範囲は RLS
 * (`audit_log_tenant_read` policy が system_admin に全行 SELECT を許す) に委譲し、
 * クエリ層は role / school_id の WHERE を書かない (ルール2 多層防御)。
 *
 * **閲覧監査 (NFR04 / ルール1)**: 本ページの表示自体を `writeViewAccessAudit`
 * (subject: "audit_log_view_access") で記録する — データ取得と**同一 withSession (tx)** 内。
 *
 * **自己言及について (意図どおり)**: このビューア自身が書く view_access 行
 * (table_name="audit_log_view_access") も次回以降の一覧に出る。これは正しい —
 * 「監査ログを誰が閲覧したか」の履歴自体が append-only + hash chain の改竄不能な監査対象であり、
 * 自身の閲覧を隠すビューアの方が NFR04 違反になる。
 *
 * **PII (ルール4)**: `diff` (jsonb) は `formatMaskedJson` (mask.ts) で識別子マスク + 切り詰めの
 * 表示専用変換を通す。保存データは変更しない。
 */
export default async function SystemAuditLogPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  await requireRole(SYSTEM_ADMIN_ROLES);
  const params = parseListParams(await searchParams, {
    sortKeys: AUDIT_LOG_SORT_KEYS,
    defaultSort: "occurredAt",
    defaultDir: "desc",
    filterKeys: ["operation", "tbl"],
  });

  // データ取得と閲覧監査を同一 tx で行う — 「見たのに記録されない」を tx 境界で排除する。
  const { page, tableNames } = await withSession(async (tx, user) => {
    const [page, tableNames] = await Promise.all([
      listAuditLogPage(tx, params),
      listAuditLogTableNames(tx),
    ]);
    await writeViewAccessAudit(tx, user, {
      subject: "audit_log_view_access",
      schoolId: null,
      detail: {
        q: params.q,
        operation: params.filters.operation ?? null,
        tbl: params.filters.tbl ?? null,
        from: params.from,
        to: params.to,
        page: params.page,
        total: page.total,
      },
    });
    return { page, tableNames };
  });
  const { rows, total } = page;

  const hasCondition =
    params.q !== "" ||
    params.from != null ||
    params.to != null ||
    Object.keys(params.filters).length > 0;

  return (
    <section>
      <header style={headerStyle}>
        <h1 style={titleStyle}>監査ログ</h1>
        <span style={countStyle}>{total.toLocaleString("ja-JP")} 件</span>
      </header>
      <p style={noteStyle}>
        全操作の監査証跡(append-only・hash chain)。本ページの閲覧も監査ログに記録されます。
      </p>

      <DataListControls
        basePath={BASE_PATH}
        params={params}
        searchPlaceholder="テーブル名・操作者UID・IP・diff内容"
        selects={[
          {
            name: "operation",
            label: "操作",
            // enum 値を網羅 (OPERATION_LABEL が Record で担保)。
            options: AUDIT_OPERATION_VALUES.map((v) => ({
              value: v,
              label: `${OPERATION_LABEL[v]} (${v})`,
            })),
          },
          {
            name: "tbl",
            label: "対象テーブル",
            // 実在値 (selectDistinct) のみ。物理テーブル名 + *_view_access 論理 subject が並ぶ。
            options: tableNames.map((t) => ({ value: t, label: t })),
          },
        ]}
        dateRange
        dateRangeLabel="発生日"
      />

      <DataTable
        basePath={BASE_PATH}
        params={params}
        empty={hasCondition ? "条件に合う監査ログがありません。" : "まだ監査ログがありません。"}
        columns={[
          { key: "occurredAt", label: "日時", sortable: true },
          { key: "actor", label: "操作者" },
          { key: "school", label: "学校" },
          { key: "tableName", label: "対象", sortable: true },
          { key: "operation", label: "操作", sortable: true },
          { key: "ip", label: "IP" },
          { key: "diff", label: "diff" },
          { key: "hash", label: "hash" },
        ]}
        rows={rows.map((r) => {
          const diffText = formatMaskedJson(r.diff);
          return {
            key: r.id,
            cells: [
              <time key="occurredAt" dateTime={r.occurredAt.toISOString()} style={dateStyle}>
                {formatJstDateTime(r.occurredAt)}
              </time>,
              // 操作者: actorIdentityUid (IdP uid、users 行削除後も残る)。null はバッチ/トリガ等の
              // 自動挿入 = 「システム」。actorUserId があれば title で突合できるようにする。
              r.actorIdentityUid ? (
                <span key="actor" title={r.actorUserId ?? undefined} style={actorStyle}>
                  {r.actorIdentityUid}
                </span>
              ) : (
                <span key="actor" title={r.actorUserId ?? undefined} style={systemActorStyle}>
                  システム
                </span>
              ),
              // school_id null = テナント横断操作 (system_admin 等)。leftJoin が外れた場合
              // (学校行の削除) は id 短縮で痕跡を残す。
              r.schoolId == null ? (
                <span key="school" style={crossTenantStyle}>
                  横断
                </span>
              ) : (
                <span key="school" title={r.schoolId}>
                  {r.schoolName ?? shortHex(r.schoolId)}
                </span>
              ),
              <span key="tableName">
                <strong>{r.tableName}</strong>
                <code style={recordIdStyle} title={r.recordId ?? undefined}>
                  {r.recordId ? shortHex(r.recordId) : "—"}
                </code>
              </span>,
              <span key="operation" style={{ whiteSpace: "nowrap" }}>
                {OPERATION_LABEL[r.operation]}
                <span style={operationRawStyle}> ({r.operation})</span>
              </span>,
              <code key="ip" style={monoStyle}>
                {r.ipAddress ?? "—"}
              </code>,
              <code key="diff" title={diffText} style={diffStyle}>
                {diffText}
              </code>,
              // hash chain の存在可視化: 先頭 8 桁 + title=フル。改竄検証自体は別途
              // チェーン再計算の領分で、ここでは「鎖に繋がれている」ことを見せる。
              <code key="hash" title={r.rowHash} style={monoStyle}>
                {shortHex(r.rowHash)}
              </code>,
            ],
          };
        })}
      />

      <PaginationNav basePath={BASE_PATH} params={params} total={total} />
    </section>
  );
}

/** uuid / SHA-256 hex の先頭 8 桁 (フル値は title 属性で渡す)。 */
function shortHex(value: string): string {
  return value.slice(0, 8);
}

/** occurredAt を JST の YYYY/MM/DD HH:mm:ss (秒まで) で表示する (サーバー描画、ロケール非依存)。 */
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
  marginBottom: space.xs,
};
const titleStyle: React.CSSProperties = { fontSize: "1.3rem", fontWeight: 700 };
const countStyle: React.CSSProperties = { fontSize: fontSize.sm, color: color.muted };
const noteStyle: React.CSSProperties = {
  fontSize: fontSize.sm,
  color: color.muted,
  margin: `0 0 ${space.md}`,
};
const dateStyle: React.CSSProperties = { color: color.muted, whiteSpace: "nowrap" };
const monoFamily = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const actorStyle: React.CSSProperties = {
  fontFamily: monoFamily,
  fontSize: fontSize.xs,
  wordBreak: "break-all",
};
const systemActorStyle: React.CSSProperties = { color: color.muted };
const crossTenantStyle: React.CSSProperties = { color: color.muted };
const recordIdStyle: React.CSSProperties = {
  display: "block",
  fontFamily: monoFamily,
  fontSize: fontSize.xs,
  color: color.muted,
};
const operationRawStyle: React.CSSProperties = { fontSize: fontSize.xs, color: color.muted };
const monoStyle: React.CSSProperties = {
  fontFamily: monoFamily,
  fontSize: fontSize.xs,
  whiteSpace: "nowrap",
};
const diffStyle: React.CSSProperties = {
  display: "block",
  fontFamily: monoFamily,
  fontSize: fontSize.xs,
  color: color.muted,
  maxWidth: "22rem",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
