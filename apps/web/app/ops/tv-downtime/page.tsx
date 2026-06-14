import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { SYSTEM_ADMIN_ROLES } from "@/lib/system-admin/roles";
import {
  TV_DOWNTIME_SORT_KEYS,
  type TvDowntimeCauseValue,
  listTvDowntimeLogPage,
} from "@/lib/system-admin/tv-ops-list";
import { TV_DOWNTIME_CAUSE_LABEL, formatDowntimeDuration } from "@/lib/tv/downtime-format";
import { shortDeviceId } from "@/lib/tv/status";
import { listSchools } from "@kimiterrace/db";
import { tokens } from "@kimiterrace/ui";
import { DataListControls } from "../../_components/datalist/DataListControls";
import { DataTable } from "../../_components/datalist/DataTable";
import { PaginationNav } from "../../_components/datalist/PaginationNav";
import { type RawSearchParams, parseListParams } from "../../_components/datalist/list-params";

const { color, fontSize, space } = tokens;

const BASE_PATH = "/ops/tv-downtime";

/**
 * 原因 (cause_hint) の表示ラベル。単一ソースは `downtime-format.ts` の
 * {@link TV_DOWNTIME_CAUSE_LABEL} (デバイス単位の稼働履歴ページと同じ文言)。
 * `Record<TvDowntimeCauseValue, string>` への代入で enum 全値の網羅をコンパイル時に強制する
 * (`tv_downtime_cause` に値が増えるとここがエラーになり気付ける、ルール3)。NULL = 未判定は表示側で倒す。
 */
const CAUSE_LABEL: Record<TvDowntimeCauseValue, string> = TV_DOWNTIME_CAUSE_LABEL;

/**
 * UIUX-03: システム管理者の **TV ダウンタイム履歴ビューア (全校横断)**
 * (`/ops/tv-downtime`)。**Server Component**。
 *
 * `tv_device_downtime` (F16 / ADR-023: 死活チェッカが populate する無応答インシデント記録) を、
 * 学校・デバイスつきで全校横断に一覧する。**デバイス単位の履歴表示とは別物**:
 * `/admin/tv-devices/[deviceId]/history` (`listTvDeviceDowntime`) は school_admin も使う 1 台分の
 * 稼働履歴 + 稼働サマリで、本ページは system_admin が「どの学校のどの TV が・いつ・どれだけ
 * 落ちていたか」を横串で運用調査する**全校横断ログ**。共通 DataList 基盤 (検索 / 列ソート /
 * 学校・復旧状態フィルタ / 発生日範囲 / ページング) を適用し、データ取得は `listTvDowntimeLogPage`
 * (apps/web/lib/system-admin/tv-ops-list.ts) が担う。
 *
 * **認可**: `requireRole(SYSTEM_ADMIN_ROLES)` (system_admin のみ)。可視範囲は RLS
 * (`system_admin_full_access`、migrations/0018) に委譲し、クエリ層は school_id / role の WHERE を
 * 書かない (ルール2 多層防御)。学校セレクトは検索条件であって境界ではない。
 *
 * **閲覧監査は書かない (意図的)**: audit/events ビューアと違い、`tv_device_downtime` は schema 設計で
 * PII 非格納 (cause_hint は機械推定の列挙値のみ、ルール4) の**機器運用ログ**であり、「誰がどの生徒情報を
 * 閲覧したか」の追跡対象 (NFR04 の view_access 監査) に該当しない。本ページの表示は読み取りのみ。
 *
 * **表示 (NFR05 / WCAG 2.2 AA)**: 復旧状態・継続時間・原因は色のみに依存せずテキストで示す。
 * 未復旧 (`recovered_at` NULL) は「未復旧」と明示し、継続秒数は確定前のため「継続中」と出す。
 * device_id はフル値を出さず短縮表示のみ (F15 §5)。
 */
export default async function SystemTvDowntimePage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  await requireRole(SYSTEM_ADMIN_ROLES);
  const params = parseListParams(await searchParams, {
    sortKeys: TV_DOWNTIME_SORT_KEYS,
    defaultSort: "wentDownAt",
    defaultDir: "desc",
    filterKeys: ["school", "state"],
  });

  const { page, schoolOptions } = await withSession(async (tx) => {
    const [page, schoolOptions] = await Promise.all([
      listTvDowntimeLogPage(tx, params),
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
        <h1 style={titleStyle}>TV ダウンタイム履歴（全校）</h1>
        <span style={countStyle}>{total.toLocaleString("ja-JP")} 件</span>
      </header>
      <p style={noteStyle}>
        全校横断の TV 無応答インシデント履歴です（死活チェッカがポーリング途絶を検出して記録）。1
        台分の 履歴と稼働サマリは各デバイスの稼働履歴ページでも確認できます。
      </p>

      <DataListControls
        basePath={BASE_PATH}
        params={params}
        searchPlaceholder="デバイスラベル（設置場所）"
        selects={[
          {
            name: "school",
            label: "学校",
            options: schoolOptions.map((s) => ({
              value: s.id,
              label: `${s.name}（${s.prefecture}）`,
            })),
          },
          {
            name: "state",
            label: "復旧状態",
            options: [
              { value: "ongoing", label: "未復旧" },
              { value: "recovered", label: "復旧済み" },
            ],
          },
        ]}
        dateRange
        dateRangeLabel="発生日"
      />

      <DataTable
        basePath={BASE_PATH}
        params={params}
        empty={
          hasCondition
            ? "条件に合うダウンタイムがありません。"
            : "まだダウンタイムの記録がありません。"
        }
        columns={[
          { key: "wentDownAt", label: "発生", sortable: true },
          { key: "recoveredAt", label: "復旧" },
          { key: "durationSec", label: "継続", sortable: true },
          { key: "schoolName", label: "学校", sortable: true },
          { key: "device", label: "デバイス" },
          { key: "cause", label: "原因" },
        ]}
        rows={rows.map((r) => ({
          key: r.id,
          cells: [
            <time key="wentDownAt" dateTime={r.wentDownAt.toISOString()} style={dateStyle}>
              {formatJstDateTime(r.wentDownAt)}
            </time>,
            // 未復旧 (recovered_at NULL) は色でなくテキストで明示 (NFR05)。
            r.recoveredAt == null ? (
              <strong key="recoveredAt" style={ongoingStyle}>
                未復旧
              </strong>
            ) : (
              <time key="recoveredAt" dateTime={r.recoveredAt.toISOString()} style={dateStyle}>
                {formatJstDateTime(r.recoveredAt)}
              </time>
            ),
            // duration_sec は復帰時に確定 (NULL = 継続中)。例: 8000 秒 → 「2時間13分20秒」。
            <span key="durationSec" style={nowrapStyle}>
              {formatDowntimeDuration(r.durationSec)}
            </span>,
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
            // NULL = 未判定 (チェッカが原因を確定できていない)。enum 値はラベル + 生値を併記。
            r.causeHint == null ? (
              <span key="cause" style={mutedStyle}>
                未判定
              </span>
            ) : (
              <span key="cause" style={nowrapStyle}>
                {CAUSE_LABEL[r.causeHint]}
                <span style={rawValueStyle}> ({r.causeHint})</span>
              </span>
            ),
          ],
        }))}
      />

      <PaginationNav basePath={BASE_PATH} params={params} total={total} />

      <p style={footnoteStyle}>
        発生時刻は最後にポーリングを観測した時刻（ここから無応答）。電源 OFF・ネットワーク断・
        アプリ停止はいずれもポーリング途絶として観測されるため、原因は復帰時の起動報告との突合による
        機械推定です（確定できない場合は原因不明 / 未判定）。
      </p>
    </section>
  );
}

/** wentDownAt 等を JST の YYYY/MM/DD HH:mm:ss で表示する (サーバー描画、ロケール非依存)。 */
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
const ongoingStyle: React.CSSProperties = { color: color.ink, whiteSpace: "nowrap" };
const footnoteStyle: React.CSSProperties = {
  color: color.muted,
  fontSize: fontSize.xs,
  marginTop: space.lg,
  lineHeight: 1.6,
};
