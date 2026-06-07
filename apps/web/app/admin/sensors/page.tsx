import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { SENSOR_WRITE_ROLES } from "@/lib/sensors/mutations-core";
import { maskDeviceMac, presentSensorStatus } from "@/lib/sensors/status-presentation";
import { SYSTEM_ADMIN_ROLES } from "@/lib/system-admin/roles";
import { type SensorDeviceStatus, listSensorDeviceStatuses } from "@kimiterrace/db";

/**
 * F13 (#391 / #408, ADR-020): 来場検知センサー管理画面 `/admin/sensors`。**Server Component**。
 *
 * 自校に登録済みの SwitchBot 人感（PIR）センサーを、設置場所・クラス・**直近検知時刻**・直近 24h の
 * 検知数・**稼働ヘルス状態**つきで一覧表示する。F13 受け入れ条件「一覧（school_admin は school_id
 * スコープ）」の読み取りに対応する。
 *
 * **本スライス (#486)**: #485（読み取り一覧）が follow-up に切り出した「healthy/quiet/dead の稼働
 * ステータス分類」を本ページに足し込む。状態判定は **サーバ側（DB の now() 基準）**で行い
 * (`listSensorDeviceStatuses`)、UI は色 + テキスト両方で示す。新規登録 / 編集 / 撤去（mutation）と
 * **system_admin の全校横断ビュー**は引き続き後続スライスに残す（#485 と同じ defer 方針）。
 *
 * **認可（校務DX原則: 監視系は運営専用）**: センサー管理は「自校の運営を見る／設定する」運用系で、先生・
 * 校長の校務を楽にする機能ではない。`/admin` レイアウトの `requireRole(ADMIN_ROLES)` に加え、本ページは
 * `requireRole(SYSTEM_ADMIN_ROLES)`（system_admin のみ）に締める。teacher / school_admin は nav から
 * 撤去済み + ここで 403（`/forbidden`）。全校横断のセンサー状態ビューは `/admin/system/sensors` で運営に
 * 提供する。データの school 境界は `withSession` が張る RLS context が DB レベルで強制する（`sensor_devices`
 * の `tenant_isolation` / `system_admin_full_access`、CLAUDE.md ルール2）。クエリは `school_id` 条件を
 * 書かず RLS に委譲する。
 *
 * **公開透明性（ADR-020）**: 来場検知は PIR センサーでカメラ非使用。ダッシュボードと同じく「カメラ不使用」
 * バッジを常時表示する。
 *
 * **アクセシビリティ（NFR05 / WCAG 2.2 AA）**: 一覧は `<table>` + `<th scope>`。稼働/撤去の状態は色だけに
 * 依存せず日本語ラベルで提示する（`presentSensorStatus` の label を併記、色のみに依存しない）。
 */
export default async function SensorsPage() {
  const user = await requireRole(SYSTEM_ADMIN_ROLES);
  const sensors = await withSession((tx) => listSensorDeviceStatuses(tx));

  // 登録/編集 (mutation) は SENSOR_WRITE_ROLES (自校 school_admin、school_id 必須) のみ。本ページは
  // system_admin 限定に締めたため、system_admin は SENSOR_WRITE_ROLES に含まれず canWrite=false となり、
  // 学校スコープ前提の登録/編集リンクは出さない (死リンクを見せない、Server Action 側も 403)。
  const canWrite = (SENSOR_WRITE_ROLES as readonly string[]).includes(user.role);

  const activeCount = sensors.filter((s) => s.decommissionedAt == null).length;

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
        {canWrite ? (
          <a href="/admin/sensors/new" style={registerLinkStyle}>
            ＋ センサーを登録
          </a>
        ) : null}
      </div>
      <p style={subtitleStyle}>
        登録センサー {sensors.length} 台（稼働中 {activeCount} 台）。稼働状態は直近の検知時刻から
        サーバー側で判定しています。
      </p>

      {sensors.length === 0 ? (
        <p style={emptyStyle}>
          登録されているセンサーがありません。SwitchBot 人感センサーを登録すると一覧に表示されます。
        </p>
      ) : (
        <table style={tableStyle}>
          <caption style={captionStyle}>
            設置場所・直近検知・稼働状態の一覧（稼働中を先頭に、直近検知が新しい順）
          </caption>
          <thead>
            <tr>
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
              <th scope="col" style={thLeftStyle}>
                操作
              </th>
            </tr>
          </thead>
          <tbody>
            {sensors.map((s) => (
              <SensorRow key={s.id} sensor={s} canWrite={canWrite} />
            ))}
          </tbody>
        </table>
      )}

      <p style={footnoteStyle}>
        稼働状態の判定: 直近 24 時間以内に検知があれば「稼働中」、24 時間〜7
        日以内なら「静観」（休日・長期休暇等）、7
        日以上検知が無ければ「応答なし」（電池切れ・通信断の
        疑い）、一度も検知が無ければ「未検知」。検知回数は人感センサーの動き検知回数で、個人を識別する
        情報は含みません。全校横断のセンサー状態ビューは「センサー管理（全校）」（/admin/system/sensors）
        で提供します。
      </p>
    </section>
  );
}

/** 一覧の 1 行。撤去済みは状態欄に明示する。canWrite (school_admin) のみ編集リンクを出す。 */
function SensorRow({ sensor, canWrite }: { sensor: SensorDeviceStatus; canWrite: boolean }) {
  const presentation = presentSensorStatus(sensor.status);
  const decommissioned = sensor.decommissionedAt != null;
  return (
    <tr style={decommissioned ? decommissionedRowStyle : undefined}>
      <th scope="row" style={tdLeftStyle}>
        {sensor.locationLabel ?? "（未設定）"}
      </th>
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
      <td style={tdLeftStyle}>
        <span style={actionsCellStyle}>
          <a
            href={`/admin/sensors/${sensor.id}/history`}
            style={editLinkStyle}
            aria-label={`${sensor.locationLabel ?? "未設定のセンサー"}の検知履歴を見る`}
          >
            履歴
          </a>
          {canWrite ? (
            <a
              href={`/admin/sensors/${sensor.id}/edit`}
              style={editLinkStyle}
              aria-label={`${sensor.locationLabel ?? "未設定のセンサー"}を編集`}
            >
              編集
            </a>
          ) : null}
        </span>
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

const headerStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: "0.75rem" };
const registerLinkStyle: React.CSSProperties = {
  marginLeft: "auto",
  fontSize: "0.85rem",
  fontWeight: 600,
  color: "#fff",
  background: "#1d4ed8",
  borderRadius: "0.4rem",
  padding: "0.4rem 0.9rem",
  textDecoration: "none",
};
const editLinkStyle: React.CSSProperties = {
  fontSize: "0.85rem",
  fontWeight: 600,
  color: "#1d4ed8",
};
const actionsCellStyle: React.CSSProperties = { display: "inline-flex", gap: "0.75rem" };
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
const thNumStyle: React.CSSProperties = { ...thLeftStyle, textAlign: "right", width: "7rem" };
const tdLeftStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "0.5rem 0.6rem",
  borderBottom: "1px solid #f3f4f6",
  fontWeight: 500,
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
