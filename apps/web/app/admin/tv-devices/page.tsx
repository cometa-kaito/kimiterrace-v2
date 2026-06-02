import { requireRole } from "@/lib/auth/guard";
import { ADMIN_ROLES } from "@/lib/nav";
import { withSession } from "@/lib/db";
import {
  TV_STATUS_ICON,
  TV_STATUS_LABEL,
  type TvLivenessStatus,
  classifyTvLiveness,
  maskMac,
  shortDeviceId,
} from "@/lib/tv/status";
import { type TvDeviceSummary, listTvDevices } from "@kimiterrace/db";
import Link from "next/link";

/**
 * F15 §4.1 / F16 §5 (ADR-022/ADR-023): TV デバイス一覧（`/admin/tv-devices`）。**Server Component**。
 *
 * **認可**: `/admin` レイアウトの `requireRole(ADMIN_ROLES)` で 401/403 を弾く。可視範囲は
 * `tv_devices` の RLS が DB レベルで決める（school_admin=自校 / system_admin=全校、ルール2）。
 * `withSession` の RLS context 下で `listTvDevices` を呼ぶ — WHERE にテナント条件は書かない。
 *
 * **本スライス（基盤・第1弾）は一覧の閲覧のみ**。詳細・編集（signage_url 自動抽出 / version +1 /
 * audit_log）、新規登録（オンボーディング + トークン発行）、コマンド発行、監査ビュー、稼働率%・
 * ダウンタイム履歴（F16 §5）は follow-up スライスに切り出す（本ページは URL 直アクセスで到達可。
 * サイドナビ `lib/nav.ts` への導線追加は他レーンとの衝突を避け follow-up）。
 *
 * **稼働ステータス**は `lib/tv/status.ts`（サーバ側純関数）で `last_seen_at` の鮮度から判定し、
 * **色 + テキストの両方**で示す（NFR05 / WCAG 2.2 AA、色のみに依存しない）。`target_mac` は末尾 4 桁
 * のみ表示（F15 §5、フル値は将来の system_admin 詳細画面のみ）。device_id も先頭のみ短縮表示。
 */
export default async function TvDevicesPage() {
  await requireRole(ADMIN_ROLES);
  const devices = await withSession((tx) => listTvDevices(tx));
  // 判定基準時刻はリクエスト時刻で固定し、全行を同一 now で判定する（行ごとの揺れを避ける）。
  const now = new Date();
  const rows = devices.map((d) => ({
    device: d,
    status: classifyTvLiveness(d.lastSeenAt, now),
  }));
  const onlineCount = rows.filter((r) => r.status === "online").length;
  const downCount = rows.filter((r) => r.status === "down").length;

  return (
    <section>
      <header style={headerStyle}>
        <h1 style={titleStyle}>TV デバイス</h1>
        <span style={countStyle}>
          稼働中 {onlineCount} / 応答なし {downCount} / 全 {devices.length} 台
        </span>
      </header>
      <p style={subtitleStyle}>
        各 TV は 60 秒ごとにサーバへ設定を取りに来ます。最終ポーリング時刻から稼働状況を判定します。
      </p>

      {devices.length === 0 ? (
        <p style={emptyStyle}>登録されている TV デバイスがありません。</p>
      ) : (
        <table style={tableStyle}>
          <caption style={captionStyle}>TV デバイスの稼働一覧</caption>
          <thead>
            <tr>
              <th scope="col" style={thLeftStyle}>
                教室ラベル
              </th>
              <th scope="col" style={thLeftStyle}>
                device_id
              </th>
              <th scope="col" style={thLeftStyle}>
                センサー MAC
              </th>
              <th scope="col" style={thNumStyle}>
                設定版
              </th>
              <th scope="col" style={thLeftStyle}>
                最終ポーリング
              </th>
              <th scope="col" style={thLeftStyle}>
                稼働ステータス
              </th>
              {/* 設定編集への導線（F15 §4.2）。実際の編集可否は編集ページの role gate + RLS が担保する。 */}
              <th scope="col" style={thLeftStyle}>
                操作
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ device, status }) => (
              <DeviceRow key={device.id} device={device} status={status} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function DeviceRow({ device, status }: { device: TvDeviceSummary; status: TvLivenessStatus }) {
  return (
    <tr>
      <th scope="row" style={tdLeftStyle}>
        {device.label ?? "（ラベル未設定）"}
        {!device.monitoringEnabled && (
          <span style={badgeStyle} title="死活監視は一時除外中（メンテナンス等）">
            監視除外
          </span>
        )}
      </th>
      <td style={tdMonoStyle}>{shortDeviceId(device.deviceId)}</td>
      <td style={tdMonoStyle}>{maskMac(device.targetMac)}</td>
      <td style={tdNumStyle}>v{device.version}</td>
      <td style={tdLeftStyle}>{formatLastSeen(device.lastSeenAt)}</td>
      <td style={tdLeftStyle}>
        {/* 色 + テキスト両方で示す（NFR05）。アイコンは色の補助、ラベルが本体。 */}
        <span style={statusCellStyle}>
          <span aria-hidden="true">{TV_STATUS_ICON[status]}</span>
          <span>{TV_STATUS_LABEL[status]}</span>
        </span>
      </td>
      <td style={tdLeftStyle}>
        {/* 行 PK（device.id）でリンク。編集ページの requireRole(TV_CONFIG_EDIT_ROLES) で teacher は 403。 */}
        <Link
          href={`/admin/tv-devices/${device.id}/edit`}
          style={editLinkStyle}
          aria-label={`${device.label ?? "ラベル未設定の TV"} の設定を編集`}
        >
          編集
        </Link>
      </td>
    </tr>
  );
}

/** 最終ポーリング時刻を JST の "M/D HH:mm" で表示。null は「未接続」。 */
function formatLastSeen(lastSeenAt: Date | null): string {
  if (lastSeenAt === null) return "未接続";
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(lastSeenAt);
}

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: "1rem",
  flexWrap: "wrap",
};
const titleStyle: React.CSSProperties = { fontSize: "1.3rem", fontWeight: 700, margin: 0 };
const countStyle: React.CSSProperties = { color: "#6b7280", fontSize: "0.85rem" };
const subtitleStyle: React.CSSProperties = { color: "#6b7280", margin: "0.35rem 0 1.25rem" };
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
  width: "5rem",
};
const tdLeftStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "0.5rem 0.6rem",
  borderBottom: "1px solid #f3f4f6",
  fontWeight: 500,
};
const tdMonoStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "0.5rem 0.6rem",
  borderBottom: "1px solid #f3f4f6",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: "0.82rem",
  color: "#374151",
};
const tdNumStyle: React.CSSProperties = {
  textAlign: "right",
  padding: "0.5rem 0.6rem",
  borderBottom: "1px solid #f3f4f6",
  fontVariantNumeric: "tabular-nums",
};
const statusCellStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.4rem",
};
const badgeStyle: React.CSSProperties = {
  marginLeft: "0.5rem",
  fontSize: "0.7rem",
  fontWeight: 600,
  color: "#92400e",
  background: "#fef3c7",
  border: "1px solid #fcd34d",
  borderRadius: "999px",
  padding: "0.1rem 0.45rem",
};
const editLinkStyle: React.CSSProperties = {
  color: "#1d4ed8",
  fontWeight: 600,
  textDecoration: "none",
};
