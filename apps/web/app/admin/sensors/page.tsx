import { requireRole } from "@/lib/auth/guard";
import { PUBLISHER_ROLES } from "@/lib/contents/publish-core";
import { withSession } from "@/lib/db";
import { listSensorDevices, type SensorDeviceListItem } from "@kimiterrace/db";

/**
 * F13 (#391 / #408, ADR-020): 来場検知センサー管理画面 `/admin/sensors` の **第1スライス（読み取り一覧）**。
 * **Server Component**。
 *
 * 自校に登録済みの SwitchBot 人感（PIR）センサーを、設置場所・種別・設置/撤去状態・**最終検知時刻**つきで
 * 一覧表示する。F13 受け入れ条件「一覧（school_admin は school_id スコープ）」の読み取り部分に対応する。
 * 新規登録 / 編集 / 撤去（mutation）と system_admin の全校横断ビュー、healthy/quiet/dead の稼働ステータス
 * 分類は後続スライスで追加する（本スライスは閲覧のみ）。
 *
 * **認可**: `/admin` レイアウトの `requireRole(ADMIN_ROLES)` に加え `requireRole(PUBLISHER_ROLES)`
 * （school_admin / teacher）。データの school 境界は `withSession` が張る RLS context が DB レベルで
 * 強制する（`sensor_devices` の `tenant_isolation`、CLAUDE.md ルール2）。クエリは `school_id` 条件を
 * 書かず RLS に委譲する。
 *
 * **公開透明性（ADR-020）**: 来場検知は PIR センサーでカメラ非使用。ダッシュボードと同じく「カメラ不使用」
 * バッジを常時表示する。
 *
 * **アクセシビリティ（NFR05 / WCAG 2.2 AA）**: 一覧は `<table>` + `<th scope>`。稼働/撤去の状態は色だけに
 * 依存せず日本語ラベルで提示する。
 */
export default async function SensorsPage() {
  await requireRole(PUBLISHER_ROLES);
  const sensors = await withSession((tx) => listSensorDevices(tx));

  return (
    <section>
      <div style={headerStyle}>
        <h1 style={titleStyle}>センサー管理</h1>
        {/* ADR-020 公開透明性: 来場検知は PIR センサーでカメラ非使用。常時バッジで明示する。 */}
        <span
          style={cameraBadgeStyle}
          title="来場検知は人感(PIR)センサーのみ。カメラ・録画は使用しません。"
        >
          カメラ不使用
        </span>
      </div>
      <p style={subtitleStyle}>自校に登録された来場検知センサーの一覧です。</p>

      {sensors.length === 0 ? (
        <p style={emptyStyle}>登録済みのセンサーはまだありません。</p>
      ) : (
        <table style={tableStyle}>
          <caption style={captionStyle}>設置場所・種別・状態・最終検知</caption>
          <thead>
            <tr>
              <th scope="col" style={thLeftStyle}>
                設置場所
              </th>
              <th scope="col" style={thLeftStyle}>
                デバイス
              </th>
              <th scope="col" style={thLeftStyle}>
                種別
              </th>
              <th scope="col" style={thLeftStyle}>
                状態
              </th>
              <th scope="col" style={thLeftStyle}>
                最終検知
              </th>
            </tr>
          </thead>
          <tbody>
            {sensors.map((s) => (
              <tr key={s.id}>
                <th scope="row" style={tdLeftStyle}>
                  {s.locationLabel ?? "（未設定）"}
                </th>
                <td style={tdMonoStyle}>{maskDeviceMac(s.deviceMac)}</td>
                <td style={tdLeftStyle}>{kindLabel(s.kind)}</td>
                <td style={tdLeftStyle}>
                  <StatusBadge decommissionedAt={s.decommissionedAt} />
                </td>
                <td style={tdLeftStyle}>{formatLastSeen(s.lastSeenAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p style={footnoteStyle}>
        稼働ステータス（正常/休止/停止）の自動分類・新規登録・編集・撤去操作は後続スライスで提供します。
      </p>
    </section>
  );
}

/** 稼働中（撤去日なし）か撤去済かを色のみに依存せず日本語ラベルで示す（NFR05）。 */
function StatusBadge({
  decommissionedAt,
}: {
  decommissionedAt: SensorDeviceListItem["decommissionedAt"];
}) {
  const active = decommissionedAt === null;
  return (
    <span style={active ? activeBadgeStyle : decommissionedBadgeStyle}>
      {active ? "稼働中" : "撤去済"}
    </span>
  );
}

/**
 * device_mac を**マスク表示**する（F13 §一覧の列仕様）。末尾 2 オクテット（区別に十分）だけ残し、それ以外の
 * 桁を伏せる。MAC 全体の露出を避けつつ、管理者が機器を識別できる粒度は保つ。コロン区切り/区切り無しの
 * どちらの登録表記でも、桁（hex）を抽出して末尾 4 桁を `··:··:..:XX:YY` 形で見せる。
 */
function maskDeviceMac(deviceMac: string): string {
  const hex = deviceMac.replace(/[^0-9a-fA-F]/g, "");
  if (hex.length <= 4) {
    return deviceMac;
  }
  const tail = hex.slice(-4).toUpperCase();
  return `··:··:··:··:${tail.slice(0, 2)}:${tail.slice(2)}`;
}

/** sensor_devices.kind を表示用ラベルにする。未知値はそのまま出す（将来種別の前方互換）。 */
function kindLabel(kind: string): string {
  if (kind === "presence_pir") {
    return "人感 (PIR)";
  }
  return kind;
}

/** 最終検知の timestamptz 文字列を JST の読みやすい表記にする。未検知は明示する。 */
function formatLastSeen(lastSeenAt: string | null): string {
  if (lastSeenAt === null) {
    return "未検知";
  }
  const d = new Date(lastSeenAt);
  if (Number.isNaN(d.getTime())) {
    return "未検知";
  }
  // JST（Asia/Tokyo）で YYYY/MM/DD HH:MM。SSR/CSR で一致させるため timeZone を固定する。
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

const headerStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: "0.75rem" };
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
const tdLeftStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "0.5rem 0.6rem",
  borderBottom: "1px solid #f3f4f6",
  fontWeight: 500,
};
const tdMonoStyle: React.CSSProperties = {
  ...tdLeftStyle,
  fontFamily: "ui-monospace, monospace",
  fontWeight: 400,
  color: "#374151",
};
const activeBadgeStyle: React.CSSProperties = {
  fontSize: "0.75rem",
  fontWeight: 600,
  color: "#065f46",
  background: "#d1fae5",
  border: "1px solid #6ee7b7",
  borderRadius: "6px",
  padding: "0.1rem 0.45rem",
};
const decommissionedBadgeStyle: React.CSSProperties = {
  fontSize: "0.75rem",
  fontWeight: 600,
  color: "#6b7280",
  background: "#f3f4f6",
  border: "1px solid #e5e7eb",
  borderRadius: "6px",
  padding: "0.1rem 0.45rem",
};
const footnoteStyle: React.CSSProperties = {
  color: "#9ca3af",
  fontSize: "0.8rem",
  marginTop: "1.5rem",
};
