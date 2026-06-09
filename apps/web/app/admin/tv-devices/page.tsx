import { isRoleAllowed, requireRole } from "@/lib/auth/guard";
import { ADMIN_ROLES } from "@/lib/nav";
import { withSession } from "@/lib/db";
import { TV_CONFIG_EDIT_ROLES } from "@/lib/tv/config-edit-core";
import { ONBOARDING_ROLES } from "@/lib/tv/onboarding-core";
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
 * 一覧は teacher も閲覧できるが、**設定編集（編集ページ）は `TV_CONFIG_EDIT_ROLES`（school_admin /
 * system_admin）限定**。teacher には 403 に終わる「編集」リンクを出さない（死リンク防止、編集ページ側の
 * `requireRole` + RLS が実体の認可。本ページの出し分けは UX 層の多層防御で、`editor` ページの広告 / 静粛
 * 時間リンク出し分けと同じ規律）。
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
  const user = await requireRole(ADMIN_ROLES);
  // 設定編集は school_admin / system_admin 限定。teacher には 403 に終わる「編集」リンクを出さない
  // （死リンク防止、#494 Reviewer Low-2）。実体の認可は編集ページの requireRole + RLS が担保する。
  const canEditConfig = isRoleAllowed(user.role, TV_CONFIG_EDIT_ROLES);
  // 新規登録（オンボーディング、F15 §4.3）は cross-tenant 操作のため system_admin 限定。teacher /
  // school_admin には登録リンクを出さない（死リンク防止、実体の認可は /new ページの requireRole）。
  const canOnboard = isRoleAllowed(user.role, ONBOARDING_ROLES);
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
        <span style={headerRightStyle}>
          <span style={countStyle}>
            稼働中 {onlineCount} / 応答なし {downCount} / 全 {devices.length} 台
          </span>
          {canOnboard && (
            <Link href="/admin/tv-devices/provision" style={onboardLinkStyle}>
              ＋ プロビジョン
            </Link>
          )}
          {canOnboard && (
            <Link href="/admin/tv-devices/new" style={onboardLinkStyle}>
              ＋ 新規登録
            </Link>
          )}
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
              {/* 操作列: 稼働履歴（F16 §5、閲覧専用なので ADMIN_ROLES 全員）+ 設定編集（F15 §4.2、編集可
                  ロールのみ）。履歴ページは全 ADMIN_ROLES 閲覧可のため列は常に出す。実体の認可は各ページの
                  role gate + RLS が担保する。 */}
              <th scope="col" style={thLeftStyle}>
                操作
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ device, status }) => (
              <DeviceRow
                key={device.id}
                device={device}
                status={status}
                canEditConfig={canEditConfig}
              />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function DeviceRow({
  device,
  status,
  canEditConfig,
}: {
  device: TvDeviceSummary;
  status: TvLivenessStatus;
  canEditConfig: boolean;
}) {
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
      {/* 稼働履歴は閲覧専用（F16 §5）で ADMIN_ROLES 全員に出す。設定編集（F15 §4.2）は編集可ロール
          （school_admin / system_admin）にだけ追加で出す（teacher に死リンクを作らない）。実体の認可は
          各ページの requireRole + RLS が担保する。 */}
      <td style={tdLeftStyle}>
        <span style={actionsCellStyle}>
          <Link
            href={`/admin/tv-devices/${device.id}/history`}
            style={editLinkStyle}
            aria-label={`${device.label ?? "ラベル未設定の TV"} の稼働履歴を表示`}
          >
            履歴
          </Link>
          {canEditConfig && (
            <Link
              href={`/admin/tv-devices/${device.id}/edit`}
              style={editLinkStyle}
              aria-label={`${device.label ?? "ラベル未設定の TV"} の設定を編集`}
            >
              編集
            </Link>
          )}
        </span>
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
const headerRightStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "1rem",
};
const onboardLinkStyle: React.CSSProperties = {
  color: "#1d4ed8",
  fontWeight: 600,
  textDecoration: "none",
  fontSize: "0.9rem",
  whiteSpace: "nowrap",
};
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
const actionsCellStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.75rem",
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
