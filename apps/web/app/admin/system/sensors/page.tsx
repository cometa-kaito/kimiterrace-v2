import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { maskDeviceMac, presentSensorStatus } from "@/lib/sensors/status-presentation";
import { SYSTEM_ADMIN_ROLES } from "@/lib/system-admin/roles";
import { type AllSensorDeviceStatus, listAllSensorStatuses } from "@kimiterrace/db";

/**
 * F13 (#391, ADR-020): システム管理者の **全校横断 センサー状態ビュー** (`/admin/system/sensors`)。
 * **Server Component**。
 *
 * `/admin/sensors` (#486) が PUBLISHER_ROLES (school_admin/teacher) の **自校**ビューなのに対し、本ページは
 * system_admin の **全校横断**ビュー。#485/#486 が明示的に後続スライスへ defer していた system_admin
 * cross-tenant ビューがこれ。F11 の `/admin/system/users` (全校横断 教職員一覧、#324) と同じ構造で、
 * 全校のセンサーを所属校名つきで一望し、各センサーが沈黙していないか (電池切れ・通信断) を運用確認する。
 *
 * **認可**: `/admin` レイアウトの `requireRole(ADMIN_ROLES)` に加え `requireRole(SYSTEM_ADMIN_ROLES)`
 * (system_admin のみ。school_admin / teacher は 403 `/forbidden`)。データの school 境界は
 * `withSession` が張る RLS context が DB レベルで強制する (`sensor_devices` / `schools` の
 * `system_admin_full_access`、CLAUDE.md ルール2)。クエリ (`listAllSensorStatuses`) は `school_id` 条件を
 * 書かず RLS に委譲する — system_admin context では全校、テナントロールなら自校のみに RLS が絞る (多層防御)。
 *
 * **公開透明性 (ADR-020)**: 来場検知は PIR センサーでカメラ非使用。自校ビューと同じく「カメラ不使用」
 * バッジを常時表示する。
 *
 * **アクセシビリティ (NFR05 / WCAG 2.2 AA)**: 一覧は `<table>` + `<th scope>`。稼働状態は色だけに依存せず
 * 日本語ラベルで提示する (`presentSensorStatus` の label を併記、色のみに依存しない)。
 */
export default async function SystemSensorsPage() {
  await requireRole(SYSTEM_ADMIN_ROLES);
  const sensors = await withSession((tx) => listAllSensorStatuses(tx));

  const activeCount = sensors.filter((s) => s.decommissionedAt == null).length;
  const schoolCount = new Set(sensors.map((s) => s.schoolId)).size;

  return (
    <section>
      <header style={headerStyle}>
        <h1 style={titleStyle}>センサー管理（全校）</h1>
        <span style={countStyle}>
          {schoolCount} 校 / 稼働 {activeCount} 台 / 全 {sensors.length} 台
        </span>
        {/* ADR-020 公開透明性: 来場検知は PIR センサーでカメラ非使用。常時バッジで明示する。 */}
        <span
          style={cameraBadgeStyle}
          title="来場検知は人感(PIR)センサーのみ。カメラ・録画は使用しません。"
        >
          カメラ不使用
        </span>
      </header>
      <p style={subtitleStyle}>
        全校横断の来場検知センサー一覧です。各センサーの所属校・設置場所・直近検知時刻・稼働状態を
        確認できます。稼働状態は直近の検知時刻からサーバー側で判定しています。新規登録・編集・撤去
        （mutation）は後続スライスで提供します。
      </p>

      {sensors.length === 0 ? (
        <p style={emptyStyle}>
          登録されているセンサーがありません。SwitchBot 人感センサーを登録すると一覧に表示されます。
        </p>
      ) : (
        <table style={tableStyle}>
          <caption style={captionStyle}>
            学校 → 稼働状態 → 直近検知の順（学校単位で固め、稼働中を先頭に直近検知が新しい順）
          </caption>
          <thead>
            <tr>
              <th scope="col" style={thLeftStyle}>
                学校
              </th>
              <th scope="col" style={thLeftStyle}>
                設置場所
              </th>
              <th scope="col" style={thLeftStyle}>
                クラス
              </th>
              <th scope="col" style={thLeftStyle}>
                デバイス
              </th>
              <th scope="col" style={thLeftStyle}>
                直近の検知
              </th>
              <th scope="col" style={thNumStyle}>
                24h 検知数
              </th>
              <th scope="col" style={thLeftStyle}>
                稼働状態
              </th>
            </tr>
          </thead>
          <tbody>
            {sensors.map((s) => (
              <SensorRow key={s.id} sensor={s} />
            ))}
          </tbody>
        </table>
      )}

      <p style={footnoteStyle}>
        稼働状態の判定: 直近 24 時間以内に検知があれば「稼働中」、24 時間〜7
        日以内なら「静観」（休日・長期休暇等）、7
        日以上検知が無ければ「応答なし」（電池切れ・通信断の
        疑い）、一度も検知が無ければ「未検知」。検知回数は人感センサーの動き検知回数で、個人を識別する
        情報は含みません。
      </p>
    </section>
  );
}

/** 一覧の 1 行。所属校名を先頭に出す。撤去済みは状態欄に明示する。 */
function SensorRow({ sensor }: { sensor: AllSensorDeviceStatus }) {
  const presentation = presentSensorStatus(sensor.status);
  const decommissioned = sensor.decommissionedAt != null;
  return (
    <tr style={decommissioned ? decommissionedRowStyle : undefined}>
      <th scope="row" style={tdLeftStyle}>
        {sensor.schoolName}
      </th>
      <td style={tdStyle}>{sensor.locationLabel ?? "（未設定）"}</td>
      <td style={tdMutedStyle}>{sensor.className ?? "—"}</td>
      <td style={tdMonoStyle} title="末尾 4 桁のみ表示（擬似識別子）">
        {maskDeviceMac(sensor.deviceMac)}
      </td>
      <td style={tdMutedStyle}>
        {sensor.lastDetectedAt == null ? "検知なし" : formatJstDateTime(sensor.lastDetectedAt)}
      </td>
      <td style={tdNumStyle}>{sensor.detections24h.toLocaleString("ja-JP")}</td>
      <td style={tdLeftStyle}>
        <span
          style={{
            ...statusBadgeStyle,
            color: presentation.color,
            background: presentation.background,
          }}
        >
          {/* aria-hidden の記号 + 必ずテキストラベルを併記 (NFR05: 色/記号のみに依存しない)。 */}
          <span aria-hidden="true">{presentation.symbol}</span>
          {presentation.label}
        </span>
        {decommissioned ? <span style={decommissionedTagStyle}>撤去済み</span> : null}
      </td>
    </tr>
  );
}

/** timestamptz を JST の YYYY/MM/DD HH:mm で表示する (サーバー描画、ロケール固定)。 */
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

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
  flexWrap: "wrap",
};
const titleStyle: React.CSSProperties = { fontSize: "1.3rem", fontWeight: 700, margin: 0 };
const countStyle: React.CSSProperties = { fontSize: "0.85rem", color: "#6b7280" };
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
const thNumStyle: React.CSSProperties = { ...thLeftStyle, textAlign: "right", width: "7rem" };
const tdLeftStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "0.5rem 0.6rem",
  borderBottom: "1px solid #f3f4f6",
  fontWeight: 500,
};
const tdStyle: React.CSSProperties = {
  padding: "0.5rem 0.6rem",
  borderBottom: "1px solid #f3f4f6",
};
const tdMutedStyle: React.CSSProperties = { ...tdLeftStyle, fontWeight: 400, color: "#6b7280" };
const tdMonoStyle: React.CSSProperties = {
  ...tdLeftStyle,
  fontWeight: 400,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  color: "#374151",
};
const tdNumStyle: React.CSSProperties = {
  textAlign: "right",
  padding: "0.5rem 0.6rem",
  borderBottom: "1px solid #f3f4f6",
  fontVariantNumeric: "tabular-nums",
};
const statusBadgeStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.35rem",
  fontSize: "0.78rem",
  fontWeight: 600,
  padding: "0.1rem 0.55rem",
  borderRadius: "999px",
};
const decommissionedRowStyle: React.CSSProperties = { opacity: 0.6 };
const decommissionedTagStyle: React.CSSProperties = {
  marginLeft: "0.5rem",
  fontSize: "0.72rem",
  color: "#6b7280",
};
const footnoteStyle: React.CSSProperties = {
  color: "#9ca3af",
  fontSize: "0.8rem",
  marginTop: "1.5rem",
  lineHeight: 1.6,
};
