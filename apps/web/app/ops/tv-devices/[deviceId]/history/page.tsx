import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { isUuid } from "@/lib/tv/config-edit-core";
import { estimateDowntimeCause } from "@/lib/tv/downtime-cause";
import {
  describeDowntimeCause,
  formatDowntimeDuration,
  formatJstTimestamp,
} from "@/lib/tv/downtime-format";
import { ADMIN_ROLES } from "@/lib/nav";
import { shortDeviceId } from "@/lib/tv/status";
import type { TvSchedule } from "@kimiterrace/db/schema";
import {
  DEFAULT_UPTIME_WINDOW_DAYS,
  type TvDowntimeHistoryRow,
  type TvUptimeSummary,
  getTvDeviceIdentity,
  getTvUptimeSummary,
  listTvDeviceDowntime,
} from "@kimiterrace/db";
import Link from "next/link";
import { notFound } from "next/navigation";

/**
 * F16 §5 (ADR-023): TV デバイスの **ダウンタイム履歴 / 稼働サマリ**（`/ops/tv-devices/[deviceId]/history`）。
 * **Server Component**。
 *
 * ルートパラメータ `deviceId` は **`tv_devices.id`（行 PK の UUID）**（編集ページと同じ参照軸）。一覧 /
 * 編集の導線から渡る。`tv_device_downtime` は `device_id`（text）で FK 参照するため、まず RLS スコープ下で
 * 行 PK → `device_id` を解決し（`getTvDeviceIdentity`）、その `device_id` で履歴・稼働サマリを引く。
 *
 * **認可**: 一覧と同じ閲覧専用ビューのため `requireRole(ADMIN_ROLES)`（school_admin / teacher /
 * system_admin）。可視範囲は `tv_devices` / `tv_device_downtime` の RLS が DB レベルで決める（school_admin=
 * 自校 / system_admin=全校、ルール2）。`withSession` の RLS context 下でクエリを呼ぶ — WHERE にテナント
 * 条件は書かない。他校 / 退役 TV は不可視 → `notFound()`。
 *
 * **表示（NFR05 / WCAG 2.2 AA）**: 状態・継続時間・原因は **色のみに依存せずテキスト**で示す。継続中
 * （`recovered_at` NULL）のアウテージは「継続中」と明示する。時刻は JST 表示。
 */
export default async function TvDeviceHistoryPage({
  params,
}: {
  params: Promise<{ deviceId: string }>;
}) {
  await requireRole(ADMIN_ROLES);
  const { deviceId } = await params;
  // 不正な id は DB に投げず即 404（UUID でないパスは存在しないものとして扱う）。
  if (!isUuid(deviceId)) {
    notFound();
  }

  // RLS context 下で 行 PK → device_id を解決 + 履歴 + 稼働サマリをまとめて引く（同一 tx・自校スコープ）。
  const data = await withSession(async (tx) => {
    const device = await getTvDeviceIdentity(tx, deviceId);
    if (!device) {
      return null;
    }
    const [history, summary] = await Promise.all([
      listTvDeviceDowntime(tx, device.deviceId),
      getTvUptimeSummary(tx, device.deviceId, DEFAULT_UPTIME_WINDOW_DAYS),
    ]);
    return { device, history, summary };
  });

  // 他校 / 存在しない / 退役 TV は RLS or deleted_at で不可視 → 404。
  if (!data) {
    notFound();
  }
  const { device, history, summary } = data;
  // 継続中行の文脈評価（要対応/様子見）はリクエストで 1 回だけ now を固定し全行で共有する
  // （時刻境界で行ごとに判定がぶれないように）。
  const now = new Date();

  return (
    <section>
      <p style={{ margin: "0 0 0.5rem" }}>
        <Link href="/ops/tv-devices" style={backLinkStyle}>
          ← TV デバイス一覧へ戻る
        </Link>
      </p>
      <header style={headerStyle}>
        <h1 style={titleStyle}>稼働履歴 — {device.label ?? "（ラベル未設定）"}</h1>
        <span style={countStyle} title="device_id（先頭のみ表示）">
          {shortDeviceId(device.deviceId)}
        </span>
      </header>
      <p style={subtitleStyle}>
        ポーリング途絶（電源OFF / ネット断 /
        アプリ停止）として検知したダウンタイムの履歴です。継続中のもの
        （未復帰）は「継続中」と表示します。
      </p>

      <UptimeSummaryCard summary={summary} alertState={device.alertState} />

      {history.length === 0 ? (
        <p style={emptyStyle}>
          記録されたダウンタイムはありません（直近で応答途絶は検知されていません）。
        </p>
      ) : (
        <table style={tableStyle}>
          <caption style={captionStyle}>ダウンタイム履歴（新しい順）</caption>
          <thead>
            <tr>
              <th scope="col" style={thLeftStyle}>
                ダウン開始
              </th>
              <th scope="col" style={thLeftStyle}>
                復帰
              </th>
              <th scope="col" style={thLeftStyle}>
                継続時間
              </th>
              <th scope="col" style={thLeftStyle}>
                状態
              </th>
              <th scope="col" style={thLeftStyle}>
                推定原因
              </th>
            </tr>
          </thead>
          <tbody>
            {history.map((row) => (
              <DowntimeRow
                key={row.id}
                row={row}
                schedule={device.scheduleJson ?? null}
                now={now}
              />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** 稼働サマリ（直近 N 日の総ダウン時間 + アウテージ件数 + 現在状態）。色のみに依存しないテキスト表示。 */
function UptimeSummaryCard({
  summary,
  alertState,
}: {
  summary: TvUptimeSummary;
  alertState: "ok" | "down";
}) {
  return (
    <dl style={summaryStyle}>
      <div style={summaryItemStyle}>
        <dt style={dtStyle}>現在の状態</dt>
        <dd style={ddStyle}>{alertState === "down" ? "応答なし（ダウン中）" : "正常"}</dd>
      </div>
      <div style={summaryItemStyle}>
        <dt style={dtStyle}>直近 {summary.windowDays} 日のダウン回数</dt>
        <dd style={ddStyle}>{summary.outageCount} 回</dd>
      </div>
      <div style={summaryItemStyle}>
        <dt style={dtStyle}>直近 {summary.windowDays} 日の総ダウン時間</dt>
        <dd style={ddStyle}>{formatDowntimeDuration(summary.totalDowntimeSec)}</dd>
      </div>
    </dl>
  );
}

/**
 * ダウンタイム 1 件の行。継続中（recovered_at NULL）は復帰列「—」・状態「継続中」で明示。
 * 推定原因は per-row 確定事実（causeHint）+ デバイスの現在 schedule から estimateDowntimeCause で導き、
 * ラベル + 根拠文 +（未確定時は）候補 3 つを色のみに依存せずテキストで示す（NFR05 / WCAG 2.2 AA、ADR-023）。
 */
function DowntimeRow({
  row,
  schedule,
  now,
}: {
  row: TvDowntimeHistoryRow;
  schedule: TvSchedule | null;
  now: Date;
}) {
  const ongoing = row.recoveredAt === null;
  const category = estimateDowntimeCause(
    {
      wentDownAt: row.wentDownAt,
      recoveredAt: row.recoveredAt,
      causeHint: row.causeHint,
      schedule,
    },
    now,
  );
  const cause = describeDowntimeCause(category);
  return (
    <tr>
      <th scope="row" style={tdLeftStyle}>
        {formatJstTimestamp(row.wentDownAt)}
      </th>
      <td style={tdLeftStyle}>{formatJstTimestamp(row.recoveredAt)}</td>
      <td style={tdLeftStyle}>{formatDowntimeDuration(row.durationSec)}</td>
      <td style={tdLeftStyle}>{ongoing ? "継続中" : "復帰済み"}</td>
      <td style={tdLeftStyle}>
        <div>{cause.label}</div>
        {cause.candidates.length > 0 ? (
          <div style={causeCandidatesStyle}>候補: {cause.candidates.join(" / ")}</div>
        ) : null}
        <div style={causeRationaleStyle}>{cause.rationale}</div>
      </td>
    </tr>
  );
}

const backLinkStyle: React.CSSProperties = {
  color: "#1d4ed8",
  fontSize: "0.85rem",
  textDecoration: "none",
};
const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: "1rem",
  flexWrap: "wrap",
};
const titleStyle: React.CSSProperties = { fontSize: "1.3rem", fontWeight: 700, margin: 0 };
const countStyle: React.CSSProperties = {
  color: "#6b7280",
  fontSize: "0.82rem",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
};
const subtitleStyle: React.CSSProperties = { color: "#6b7280", margin: "0.35rem 0 1.25rem" };
const emptyStyle: React.CSSProperties = { color: "#6b7280" };
const summaryStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "1.5rem",
  margin: "0 0 1.5rem",
  padding: "1rem 1.25rem",
  background: "#f9fafb",
  border: "1px solid #e5e7eb",
  borderRadius: "0.5rem",
};
const summaryItemStyle: React.CSSProperties = { margin: 0 };
const dtStyle: React.CSSProperties = {
  color: "#6b7280",
  fontSize: "0.78rem",
  margin: "0 0 0.2rem",
};
const ddStyle: React.CSSProperties = { margin: 0, fontSize: "1.05rem", fontWeight: 700 };
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
const tdLeftStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "0.5rem 0.6rem",
  borderBottom: "1px solid #f3f4f6",
  fontWeight: 500,
};
const causeCandidatesStyle: React.CSSProperties = {
  color: "#6b7280",
  fontSize: "0.78rem",
  fontWeight: 400,
  marginTop: "0.15rem",
};
const causeRationaleStyle: React.CSSProperties = {
  color: "#6b7280",
  fontSize: "0.75rem",
  fontWeight: 400,
  marginTop: "0.15rem",
  maxWidth: "28rem",
  lineHeight: 1.5,
};
