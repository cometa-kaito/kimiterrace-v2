import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { formatMaskedJson } from "@/lib/system-admin/mask";
import { SYSTEM_ADMIN_ROLES } from "@/lib/system-admin/roles";
import {
  TV_COMMAND_SORT_KEYS,
  TV_COMMAND_STATUS_VALUES,
  TV_COMMAND_TYPE_VALUES,
  type TvCommandStatusValue,
  type TvCommandTypeValue,
  listTvCommandLogPage,
} from "@/lib/system-admin/tv-ops-list";
import { TV_COMMAND_LABELS, TV_COMMAND_STATUS_LABELS } from "@/lib/tv/command-core";
import { shortDeviceId } from "@/lib/tv/status";
import { listSchools } from "@kimiterrace/db";
import { tokens } from "@kimiterrace/ui";
import { DataListControls } from "../../_components/datalist/DataListControls";
import { DataTable } from "../../_components/datalist/DataTable";
import { PaginationNav } from "../../_components/datalist/PaginationNav";
import { type RawSearchParams, parseListParams } from "../../_components/datalist/list-params";

const { color, fontSize, space } = tokens;

const BASE_PATH = "/ops/tv-commands";

/**
 * コマンド種別の表示ラベル。単一ソースは `command-core.ts` の {@link TV_COMMAND_LABELS}
 * (発行ボタンと同じ文言)。`Record<TvCommandTypeValue, string>` への代入で enum 全値の網羅を
 * コンパイル時に強制する (型でズレ検出、ルール3)。
 */
const COMMAND_LABEL: Record<TvCommandTypeValue, string> = TV_COMMAND_LABELS;

/** コマンド状態の表示ラベル。単一ソースは {@link TV_COMMAND_STATUS_LABELS}。enum 網羅を型で強制。 */
const STATUS_LABEL: Record<TvCommandStatusValue, string> = TV_COMMAND_STATUS_LABELS;

/**
 * UIUX-03: システム管理者の **TV リモートコマンド履歴ビューア (全校横断)**
 * (`/ops/tv-commands`)。**Server Component**。
 *
 * `tv_device_commands` (F15 / ADR-022: ポーリング型コマンドキュー) の発行履歴を、学校・デバイス・
 * 発行者つきで全校横断に一覧する。**デバイス単位の履歴表示とは別物**: `/admin/tv-devices/[deviceId]/edit`
 * の「最近のコマンド」(`listRecentTvCommands`) は school_admin も使う 1 台分の直近表示で、本ページは
 * system_admin が「どの学校のどの TV に・誰が・何を・届いたか」を運用調査する**全校横断ログ**。
 * 共通 DataList 基盤 (検索 / 列ソート / 状態・種別・学校フィルタ / 発行日範囲 / ページング) を適用し、
 * データ取得は `listTvCommandLogPage` (apps/web/lib/system-admin/tv-ops-list.ts) が担う。
 *
 * **認可**: `requireRole(SYSTEM_ADMIN_ROLES)` (system_admin のみ)。可視範囲は RLS
 * (`system_admin_full_access`、migrations/0019) に委譲し、クエリ層は school_id / role の WHERE を
 * 書かない (ルール2 多層防御)。学校セレクトは検索条件であって境界ではない。
 *
 * **閲覧監査は書かない (意図的)**: audit/events ビューアと違い、`tv_device_commands` は schema 設計で
 * PII 非格納 (params_json は機械メタのみ、ルール4) の**機器運用ログ**であり、「誰がどの生徒情報を
 * 閲覧したか」の追跡対象 (NFR04 の view_access 監査) に該当しない。発行操作そのものの監査は
 * `enqueueTvCommand` が audit_log に残しており、本ページの表示は読み取りのみ。
 *
 * **PII (ルール4)**: params_json は `formatMaskedJson` (識別子マスク + 切り詰め) を通して表示する。
 * device_id はフル値を出さず短縮表示のみ (F15 §5)。
 */
export default async function SystemTvCommandsPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  await requireRole(SYSTEM_ADMIN_ROLES);
  const params = parseListParams(await searchParams, {
    sortKeys: TV_COMMAND_SORT_KEYS,
    defaultSort: "issuedAt",
    defaultDir: "desc",
    filterKeys: ["status", "type", "school"],
  });

  const { page, schoolOptions } = await withSession(async (tx) => {
    const [page, schoolOptions] = await Promise.all([
      listTvCommandLogPage(tx, params),
      listSchools(tx),
    ]);
    return { page, schoolOptions };
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
        <h1 style={titleStyle}>TV コマンド履歴（全校）</h1>
        <span style={countStyle}>{total.toLocaleString("ja-JP")} 件</span>
      </header>
      <p style={noteStyle}>
        全校横断の TV リモートコマンド発行履歴です。配信はポーリング型（各 TV が最大 60
        秒間隔で受信して ack）。1 台分の直近履歴は各デバイスの編集ページでも確認できます。
      </p>

      <DataListControls
        basePath={BASE_PATH}
        params={params}
        searchPlaceholder="デバイスラベル（設置場所）"
        selects={[
          {
            name: "status",
            label: "状態",
            // enum 値を網羅 (STATUS_LABEL が Record で担保)。
            options: TV_COMMAND_STATUS_VALUES.map((v) => ({
              value: v,
              label: `${STATUS_LABEL[v]} (${v})`,
            })),
          },
          {
            name: "type",
            label: "種別",
            // enum 値を網羅 (COMMAND_LABEL が Record で担保)。
            options: TV_COMMAND_TYPE_VALUES.map((v) => ({
              value: v,
              label: COMMAND_LABEL[v],
            })),
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
        dateRangeLabel="発行日"
      />

      <DataTable
        basePath={BASE_PATH}
        params={params}
        empty={
          hasCondition ? "条件に合うコマンドがありません。" : "まだコマンドの発行履歴がありません。"
        }
        columns={[
          { key: "issuedAt", label: "発行日時", sortable: true },
          { key: "schoolName", label: "学校", sortable: true },
          { key: "device", label: "デバイス" },
          { key: "command", label: "種別", sortable: true },
          { key: "status", label: "状態", sortable: true },
          { key: "issuer", label: "発行者" },
          { key: "params", label: "params（マスク済み）" },
        ]}
        rows={rows.map((r) => ({
          key: r.id,
          cells: [
            <time key="issuedAt" dateTime={r.issuedAt.toISOString()} style={dateStyle}>
              {formatJstDateTime(r.issuedAt)}
            </time>,
            r.schoolName,
            // ラベル (設置場所) があればラベル、無ければ device_id 短縮 (フル値は出さない、F15 §5)。
            r.deviceLabel != null ? (
              <span key="device" title={shortDeviceId(r.deviceId)}>
                {r.deviceLabel}
              </span>
            ) : (
              <code key="device" style={monoStyle} title="device_id（先頭のみ表示）">
                {shortDeviceId(r.deviceId)}
              </code>
            ),
            <span key="command" style={nowrapStyle}>
              {COMMAND_LABEL[r.command]}
              <span style={rawValueStyle}> ({r.command})</span>
            </span>,
            // delivered の ack 時刻は title で補足 (列を増やさず「いつ届いたか」を引けるように)。
            <span
              key="status"
              style={nowrapStyle}
              title={
                r.acknowledgedAt != null
                  ? `受領: ${formatJstDateTime(r.acknowledgedAt)}`
                  : undefined
              }
            >
              {STATUS_LABEL[r.status]}
              <span style={rawValueStyle}> ({r.status})</span>
            </span>,
            // issued_by null = system_admin 発行 (users 行でないため null、enqueueTvCommand 参照)。
            // users 行が引けない場合は id 短縮で痕跡を残す (フル値は title)。
            r.issuedBy == null ? (
              <span key="issuer" style={mutedStyle}>
                システム管理者
              </span>
            ) : (
              <span key="issuer" title={r.issuedBy}>
                {r.issuerName ?? shortHex(r.issuedBy)}
              </span>
            ),
            r.paramsJson == null ? (
              <span key="params" style={mutedStyle}>
                —
              </span>
            ) : (
              <code key="params" title={formatMaskedJson(r.paramsJson)} style={paramsStyle}>
                {formatMaskedJson(r.paramsJson)}
              </code>
            ),
          ],
        }))}
      />

      <PaginationNav basePath={BASE_PATH} params={params} total={total} />
    </section>
  );
}

/** uuid の先頭 8 桁 (フル値は title 属性で渡す)。 */
function shortHex(value: string): string {
  return value.slice(0, 8);
}

/** issuedAt 等を JST の YYYY/MM/DD HH:mm:ss で表示する (サーバー描画、ロケール非依存)。 */
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
const titleStyle: React.CSSProperties = { fontSize: "1.3rem", fontWeight: 700, margin: 0 };
const countStyle: React.CSSProperties = { fontSize: fontSize.sm, color: color.muted };
const noteStyle: React.CSSProperties = {
  fontSize: fontSize.sm,
  color: color.muted,
  margin: `0 0 ${space.md}`,
};
const dateStyle: React.CSSProperties = { color: color.muted, whiteSpace: "nowrap" };
const monoFamily = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const monoStyle: React.CSSProperties = {
  fontFamily: monoFamily,
  fontSize: fontSize.xs,
  whiteSpace: "nowrap",
};
const nowrapStyle: React.CSSProperties = { whiteSpace: "nowrap" };
const rawValueStyle: React.CSSProperties = { fontSize: fontSize.xs, color: color.muted };
const mutedStyle: React.CSSProperties = { color: color.muted };
const paramsStyle: React.CSSProperties = {
  display: "block",
  fontFamily: monoFamily,
  fontSize: fontSize.xs,
  color: color.muted,
  maxWidth: "22rem",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
