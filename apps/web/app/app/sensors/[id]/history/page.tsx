import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import {
  type PresenceRangeKey,
  presenceRangeOptions,
  resolvePresenceRange,
} from "@/lib/sensors/presence-history-range";
import { maskDeviceMac } from "@/lib/sensors/status-presentation";
import { SYSTEM_ADMIN_ROLES } from "@/lib/system-admin/roles";
import { getOwnSensorDevice, getPresenceHistory } from "@kimiterrace/db";
import { notFound } from "next/navigation";

/**
 * F13 (#391, ADR-020): 来場検知センサーの **検知履歴**ページ `/app/sensors/[id]/history`。
 * **Server Component**。ユーザー依頼「人感センサのデータを過去のデータなど全て UI から見れるように」。
 *
 * 1 センサーの過去の検知を ①JST 日別の検知数、②最新の生検知一覧（時刻・状態）で時系列に見せる。期間は
 * `?range=`（1d/7d/30d/90d/all）で切替。一覧（俯瞰）は `/app/sensors`、本ページは個別深掘り。
 *
 * **認可（校務DX原則: 監視系は運営専用）**: 一覧 / 編集と同じく `requireRole(SYSTEM_ADMIN_ROLES)`
 * （system_admin のみ）。teacher / school_admin は nav 非掲載 + 403。対象センサーと履歴を 1 つの
 * `withSession` RLS tx で取得する。`getOwnSensorDevice` は RLS で可視行のみ = 不可視/不存在の id は null
 * → 404（越境参照を見せない）。データの school 境界・presence 結合は RLS が DB レベルで強制する（ルール2）。
 *
 * **PII 非格納 / 透明性（ルール4 / ADR-020）**: PIR はカメラ非搭載・個人識別なし。表示は検知時刻・状態・
 * 件数の匿名メタのみ。「カメラ不使用」バッジを常時表示。**アクセシビリティ（NFR05）**: 状態は色のみに
 * 依存せず日本語ラベル併記、一覧は `<table>` + `<th scope>`。
 */
export default async function SensorHistoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ range?: string }>;
}) {
  await requireRole(SYSTEM_ADMIN_ROLES);
  const { id } = await params;
  const { range: rangeParam } = await searchParams;
  // now はサーバー時刻（クライアント時刻不信）。範囲プリセットを from/to に解決。
  const range = resolvePresenceRange(rangeParam, new Date());

  const data = await withSession(async (tx) => {
    const sensor = await getOwnSensorDevice(tx, id);
    if (!sensor) {
      return null;
    }
    const history = await getPresenceHistory(tx, {
      sensorId: id,
      from: range.from,
      to: range.to,
    });
    return { sensor, history };
  });

  if (!data) {
    notFound();
  }

  const { sensor, history } = data;
  const maxDaily = history.dailyCounts.reduce((m, d) => Math.max(m, d.count), 0);

  return (
    <section>
      <p style={backLinkStyle}>
        <a href="/app/sensors" style={linkStyle}>
          ← センサー管理に戻る
        </a>
      </p>

      <div style={headerStyle}>
        <h1 style={titleStyle}>検知履歴: {sensor.locationLabel ?? "（設置場所 未設定）"}</h1>
        <span
          style={cameraBadgeStyle}
          title="来場検知は人感(PIR)センサーのみ。カメラ・録画は使用しません。"
        >
          カメラ不使用
        </span>
      </div>
      <p style={metaStyle}>
        デバイス <span style={monoStyle}>{maskDeviceMac(sensor.deviceMac)}</span>
        {sensor.decommissionedAt != null ? <span style={tagStyle}>撤去済み</span> : null}
      </p>

      {/* 期間プリセット切替（Server Component: ?range= リンクのみ、クライアント JS 不要）。 */}
      <nav aria-label="表示期間の切替" style={rangeNavStyle}>
        {presenceRangeOptions(range.key).map((opt) => (
          <RangeLink
            key={opt.key}
            sensorId={id}
            optKey={opt.key}
            label={opt.label}
            active={opt.active}
          />
        ))}
      </nav>

      <p style={summaryStyle}>
        <strong style={{ fontSize: "1.5rem", color: "#111827" }}>
          {history.totalInRange.toLocaleString("ja-JP")}
        </strong>{" "}
        回の検知（{range.label}）
      </p>

      {history.totalInRange === 0 ? (
        <p style={emptyStyle}>
          この期間に検知はありません。期間を広げるか、センサーの稼働状態をご確認ください。
        </p>
      ) : (
        <>
          {/* 日別検知数（簡易バー）。色のみに依存せず数値も併記。 */}
          <h2 style={subHeadStyle}>日別の検知数</h2>
          <table style={tableStyle}>
            <caption style={captionStyle}>JST 暦日ごとの検知回数（古い順）</caption>
            <thead>
              <tr>
                <th scope="col" style={thLeftStyle}>
                  日付（JST）
                </th>
                <th scope="col" style={thLeftStyle}>
                  検知数
                </th>
              </tr>
            </thead>
            <tbody>
              {history.dailyCounts.map((d) => (
                <tr key={d.day}>
                  <th scope="row" style={tdLeftStyle}>
                    {d.day}
                  </th>
                  <td style={tdBarCellStyle}>
                    <span
                      aria-hidden="true"
                      style={{
                        ...barStyle,
                        width: maxDaily > 0 ? `${Math.max(4, (d.count / maxDaily) * 100)}%` : "0%",
                      }}
                    />
                    <span style={barCountStyle}>{d.count.toLocaleString("ja-JP")}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* 最新の生検知。truncated の時は最新 N 件のみと明示。 */}
          <h2 style={subHeadStyle}>最新の検知ログ</h2>
          {history.truncated ? (
            <p style={truncatedNoteStyle}>
              検知が多いため、この期間の最新 {history.events.length.toLocaleString("ja-JP")}{" "}
              件のみ表示しています（合計 {history.totalInRange.toLocaleString("ja-JP")}{" "}
              件）。古い検知は期間を絞ってご確認ください。
            </p>
          ) : null}
          <table style={tableStyle}>
            <caption style={captionStyle}>検知時刻と状態（新しい順）</caption>
            <thead>
              <tr>
                <th scope="col" style={thLeftStyle}>
                  検知時刻（JST）
                </th>
                <th scope="col" style={thLeftStyle}>
                  状態
                </th>
              </tr>
            </thead>
            <tbody>
              {history.events.map((e) => (
                <tr key={e.id}>
                  <th scope="row" style={tdLeftStyle}>
                    {formatJstDateTime(e.occurredAt)}
                  </th>
                  <td style={tdMutedStyle}>{e.detectionState ?? "検知"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <p style={footnoteStyle}>
        検知回数は人感（PIR）センサーの動き検知回数で、個人を識別する情報は含みません。日別集計は
        JST の暦日基準です。
      </p>
    </section>
  );
}

/** 期間プリセットの切替リンク。active は強調しリンクにしない（現在地）。 */
function RangeLink({
  sensorId,
  optKey,
  label,
  active,
}: {
  sensorId: string;
  optKey: PresenceRangeKey;
  label: string;
  active: boolean;
}) {
  if (active) {
    return (
      <span aria-current="true" style={{ ...rangeChipStyle, ...rangeChipActiveStyle }}>
        {label}
      </span>
    );
  }
  return (
    <a href={`/app/sensors/${sensorId}/history?range=${optKey}`} style={rangeChipStyle}>
      {label}
    </a>
  );
}

/** timestamptz を JST の YYYY/MM/DD HH:mm で表示する（サーバー描画、ロケール固定）。 */
function formatJstDateTime(value: Date): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}

const backLinkStyle: React.CSSProperties = { margin: "0 0 0.75rem", fontSize: "0.85rem" };
const linkStyle: React.CSSProperties = { color: "#1d4ed8", fontWeight: 600 };
const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
  flexWrap: "wrap",
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
const metaStyle: React.CSSProperties = {
  color: "#6b7280",
  margin: "0.35rem 0 1rem",
  fontSize: "0.9rem",
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
};
const monoStyle: React.CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  color: "#374151",
};
const tagStyle: React.CSSProperties = { fontSize: "0.72rem", color: "#6b7280" };
const rangeNavStyle: React.CSSProperties = {
  display: "flex",
  gap: "0.4rem",
  flexWrap: "wrap",
  margin: "0 0 1rem",
};
const rangeChipStyle: React.CSSProperties = {
  fontSize: "0.85rem",
  fontWeight: 600,
  color: "#374151",
  background: "#f3f4f6",
  border: "1px solid #d1d5db",
  borderRadius: "999px",
  padding: "0.3rem 0.8rem",
  textDecoration: "none",
};
const rangeChipActiveStyle: React.CSSProperties = {
  color: "#fff",
  background: "#1d4ed8",
  borderColor: "#1d4ed8",
};
const summaryStyle: React.CSSProperties = { margin: "0 0 1.25rem", color: "#374151" };
const subHeadStyle: React.CSSProperties = {
  fontSize: "1rem",
  fontWeight: 700,
  margin: "1.5rem 0 0.5rem",
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
const tdLeftStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "0.5rem 0.6rem",
  borderBottom: "1px solid #f3f4f6",
  fontWeight: 500,
  whiteSpace: "nowrap",
};
const tdMutedStyle: React.CSSProperties = { ...tdLeftStyle, fontWeight: 400, color: "#6b7280" };
const tdBarCellStyle: React.CSSProperties = {
  padding: "0.4rem 0.6rem",
  borderBottom: "1px solid #f3f4f6",
  display: "flex",
  alignItems: "center",
  gap: "0.6rem",
};
const barStyle: React.CSSProperties = {
  display: "inline-block",
  height: "0.8rem",
  background: "#93c5fd",
  borderRadius: "0.2rem",
  minWidth: "2px",
};
const barCountStyle: React.CSSProperties = {
  fontVariantNumeric: "tabular-nums",
  color: "#374151",
  fontSize: "0.85rem",
};
const truncatedNoteStyle: React.CSSProperties = {
  color: "#92400e",
  background: "#fef3c7",
  border: "1px solid #fcd34d",
  borderRadius: "0.4rem",
  padding: "0.5rem 0.75rem",
  fontSize: "0.82rem",
  margin: "0 0 0.75rem",
};
const footnoteStyle: React.CSSProperties = {
  color: "#9ca3af",
  fontSize: "0.8rem",
  marginTop: "1.5rem",
  lineHeight: 1.6,
};
