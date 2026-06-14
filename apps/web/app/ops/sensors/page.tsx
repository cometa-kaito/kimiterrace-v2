import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { maskDeviceMac, presentSensorStatus } from "@/lib/sensors/status-presentation";
import { SYSTEM_ADMIN_ROLES } from "@/lib/system-admin/roles";
import { SENSOR_SORT_KEYS, listSensorsPage } from "@/lib/system-admin/sensor-list";
import { tokens } from "@kimiterrace/ui";
import Link from "next/link";
import { DataListControls } from "../../_components/datalist/DataListControls";
import { DataTable } from "../../_components/datalist/DataTable";
import { PaginationNav } from "../../_components/datalist/PaginationNav";
import { type RawSearchParams, parseListParams } from "../../_components/datalist/list-params";
import { SensorDecommissionButton } from "./_components/SensorDecommissionButton";

const { color, fontSize, radius, space } = tokens;

const BASE_PATH = "/ops/sensors";

/**
 * F13 (#391, ADR-020) / UIUX-03 / §43: システム管理者の **全校横断 センサー状態ビュー** +
 * **登録 / 編集 / 履歴の導線** (`/ops/sensors`)。**Server Component**。
 *
 * §43 でかつての自校重複 `/app/sensors` (system_admin 限定に締まり死んでいた一覧) を撤去し、本ページに
 * 統合した。全校のセンサーを所属校名つきで一望し、各センサーが沈黙していないか (電池切れ・通信断) を
 * 運用確認する。CRUD (新規登録 `new` / 編集 `[id]/edit` / 履歴 `[id]/history`) は本ルート配下へ移設済み
 * (§43、旧 `/app/sensors/...` から git mv)。UIUX-03 で共通 DataList 基盤 (検索 / 列ソート /
 * 稼働状態・撤去状態フィルタ / 設置日範囲 / ページング) を適用 — データ取得は `listSensorsPage`
 * (apps/web/lib) が担う (集計セマンティクスは packages/db に単一ソースのまま)。
 *
 * **認可**: `/admin` レイアウトの `requireRole(ADMIN_ROLES)` に加え `requireRole(SYSTEM_ADMIN_ROLES)`
 * (system_admin のみ。school_admin / teacher は 403 `/forbidden`)。データの school 境界は
 * `withSession` が張る RLS context が DB レベルで強制する (CLAUDE.md ルール2)。クエリ層は
 * `school_id` 条件を書かず RLS に委譲する (多層防御)。登録/編集の Server Action は `SENSOR_WRITE_ROLES`
 * (自校 school_admin、school_id 必須) を要し、system_admin は actor 不一致で実書き込みはできない
 * (フォームは開けるが送信は forbidden。運営は read 中心という移設前の方針を維持)。
 *
 * **公開透明性 (ADR-020)**: 来場検知は PIR センサーでカメラ非使用。「カメラ不使用」バッジを常時表示。
 *
 * **アクセシビリティ (NFR05 / WCAG 2.2 AA)**: 稼働状態は色だけに依存せず日本語ラベルで提示する
 * (`presentSensorStatus` の label を併記)。ソート状態は DataTable が記号 + aria-sort で示す。
 */
export default async function SystemSensorsPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  await requireRole(SYSTEM_ADMIN_ROLES);
  const params = parseListParams(await searchParams, {
    sortKeys: SENSOR_SORT_KEYS,
    defaultSort: "school",
    defaultDir: "asc",
    filterKeys: ["status", "state"],
  });
  const { rows, total, summary } = await withSession((tx) => listSensorsPage(tx, params));

  return (
    <section>
      <header style={headerStyle}>
        <h1 style={titleStyle}>センサー管理（全校）</h1>
        <span style={countStyle}>
          {summary.schoolCount} 校 / 稼働 {summary.activeCount} 台 / 全 {summary.sensorCount} 台
        </span>
        {/* ADR-020 公開透明性: 来場検知は PIR センサーでカメラ非使用。常時バッジで明示する。 */}
        <span
          style={cameraBadgeStyle}
          title="来場検知は人感(PIR)センサーのみ。カメラ・録画は使用しません。"
        >
          カメラ不使用
        </span>
        {/* §43: 登録/編集導線は本ルート配下へ移設済み。実書き込みは SENSOR_WRITE_ROLES (自校 school_admin) のみ。 */}
        <Link href="/ops/sensors/new" style={registerLinkStyle}>
          ＋ センサーを登録
        </Link>
      </header>
      <p style={subtitleStyle}>
        全校横断の来場検知センサー一覧です。各センサーの所属校・設置場所・直近検知時刻・稼働状態を
        確認できます。稼働状態は直近の検知時刻からサーバー側で判定しています。各行から検知履歴を確認でき、
        設置場所・クラスの編集や新規登録の導線も本ページに統合しています（§43）。
      </p>

      <DataListControls
        basePath={BASE_PATH}
        params={params}
        searchPlaceholder="学校名・設置場所・クラス・デバイスMAC"
        selects={[
          {
            name: "status",
            label: "稼働状態",
            // ラベルは presentSensorStatus と同一ソース (フィルタ表示と一覧バッジのズレ防止)。
            options: (["healthy", "quiet", "dead", "never"] as const).map((value) => ({
              value,
              label: presentSensorStatus(value).label,
            })),
          },
          {
            name: "state",
            label: "撤去状態",
            options: [
              { value: "active", label: "未撤去" },
              { value: "decommissioned", label: "撤去済み" },
            ],
          },
        ]}
        dateRange
        dateRangeLabel="設置日"
      />

      <DataTable
        basePath={BASE_PATH}
        params={params}
        empty={
          summary.sensorCount === 0
            ? "登録されているセンサーがありません。SwitchBot 人感センサーを登録すると一覧に表示されます。"
            : "条件に合うセンサーがありません。"
        }
        columns={[
          { key: "school", label: "学校", sortable: true },
          { key: "location", label: "設置場所", sortable: true },
          { key: "class", label: "クラス", sortable: true },
          { key: "device", label: "デバイス" },
          { key: "installedAt", label: "設置日", sortable: true },
          { key: "lastDetectedAt", label: "直近の検知", sortable: true },
          { key: "detections24h", label: "24h 検知数", sortable: true, align: "right" },
          { key: "status", label: "稼働状態", sortable: true },
          { key: "actions", label: "操作" },
        ]}
        rows={rows.map((s) => {
          const presentation = presentSensorStatus(s.status);
          const decommissioned = s.decommissionedAt != null;
          return {
            key: s.id,
            cells: [
              <strong key="school">{s.schoolName}</strong>,
              s.locationLabel ?? "（未設定）",
              s.className ?? "—",
              <span key="device" style={monoStyle} title="末尾 4 桁のみ表示（擬似識別子）">
                {maskDeviceMac(s.deviceMac)}
              </span>,
              formatJstDate(s.installedAt),
              s.lastDetectedAt == null ? "検知なし" : formatJstDateTime(s.lastDetectedAt),
              s.detections24h.toLocaleString("ja-JP"),
              <span key="status">
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
              </span>,
              // §43: 履歴 (read) / 編集 (mutation) の行内導線。リンク先は本ルート配下に移設済み。
              <span key="actions" style={actionsCellStyle}>
                <Link
                  href={`/ops/sensors/${s.id}/history`}
                  style={actionLinkStyle}
                  prefetch={false}
                  aria-label={`${s.locationLabel ?? "未設定のセンサー"}の検知履歴を見る`}
                >
                  履歴
                </Link>
                <Link
                  href={`/ops/sensors/${s.id}/edit`}
                  style={actionLinkStyle}
                  prefetch={false}
                  aria-label={`${s.locationLabel ?? "未設定のセンサー"}を編集`}
                >
                  編集
                </Link>
                {/* 撤去 / 再稼働 (運営整理 §4 item5)。system_admin が任意校のセンサーを論理撤去できる。 */}
                <SensorDecommissionButton
                  sensorId={s.id}
                  decommissioned={decommissioned}
                  label={s.locationLabel ?? s.schoolName}
                />
              </span>,
            ],
          };
        })}
      />

      <PaginationNav basePath={BASE_PATH} params={params} total={total} />

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

/** timestamptz を JST の YYYY/MM/DD で表示する (サーバー描画、ロケール非依存に固定)。 */
function formatJstDate(value: Date): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
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
  gap: space.md,
  flexWrap: "wrap",
};
const titleStyle: React.CSSProperties = { fontSize: "1.3rem", fontWeight: 700, margin: 0 };
const countStyle: React.CSSProperties = { fontSize: fontSize.sm, color: color.muted };
const registerLinkStyle: React.CSSProperties = {
  marginLeft: "auto",
  fontSize: fontSize.sm,
  fontWeight: 600,
  color: "#fff",
  background: "#1d4ed8",
  borderRadius: radius.md,
  padding: "0.4rem 0.9rem",
  textDecoration: "none",
};
const actionsCellStyle: React.CSSProperties = {
  display: "inline-flex",
  gap: space.sm,
  whiteSpace: "nowrap",
};
const actionLinkStyle: React.CSSProperties = {
  fontSize: fontSize.sm,
  fontWeight: 600,
  color: "#1d4ed8",
};
const cameraBadgeStyle: React.CSSProperties = {
  fontSize: "0.7rem",
  fontWeight: 600,
  color: color.successFg,
  background: color.successBg,
  border: `1px solid ${color.successBorder}`,
  borderRadius: radius.pill,
  padding: "0.15rem 0.6rem",
};
const subtitleStyle: React.CSSProperties = {
  color: color.muted,
  margin: `${space.xs} 0 ${space.lg}`,
};
const monoStyle: React.CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  color: color.neutralFg,
};
const statusBadgeStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.35rem",
  fontSize: fontSize.xs,
  fontWeight: 600,
  padding: "0.1rem 0.55rem",
  borderRadius: radius.pill,
  whiteSpace: "nowrap",
};
const decommissionedTagStyle: React.CSSProperties = {
  marginLeft: space.sm,
  fontSize: "0.72rem",
  color: color.muted,
};
const footnoteStyle: React.CSSProperties = {
  color: "#9ca3af",
  fontSize: fontSize.xs,
  marginTop: space.lg,
  lineHeight: 1.6,
};
