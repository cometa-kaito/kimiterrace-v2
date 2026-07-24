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
import { type TvDeviceSummary, listSchools, listTvDevices } from "@kimiterrace/db";
import Link from "next/link";
import { DataListControls } from "../../_components/datalist/DataListControls";
import { type RawSearchParams, parseListParams } from "../../_components/datalist/list-params";

/**
 * F15 §4.1 / F16 §5 (ADR-022/ADR-023): TV デバイス一覧（`/ops/tv-devices`）。**Server Component**。
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
 *
 * **学校の次元**: `label` は設置場所の自由文字列で、学校をまたぐと容易に重複する（「進路指導室前」が
 * 各務原 3 校 + 岐南工業に並ぶ）。全校を見る運用者が行を identify できるよう、**学校列**（`listTvDevices`
 * が `schools` を JOIN 解決）と **学校セレクト**（`?school=<uuid>`、共通 DataList 基盤のフィルタバー）を
 * 出す。既定の並びも校名 → ラベルなので同名ラベルが学校ごとにまとまる。どちらも**自校しか見えない
 * 閲覧者には出さない**（全行同じ値・選択肢 1 個でノイズになるため、可視学校数から導く）。学校絞り込みは
 * 検索条件であってテナント境界ではない — 境界は RLS が DB レベルで守る（ルール2、/ops/tv-downtime と同方針）。
 */
/** 稼働ステータス絞り込みのタブ順。「応答なし→未接続」を先頭寄りにして要対応を素早く拾えるようにする。 */
const STATUS_FILTERS = ["all", "down", "never", "quiet", "online"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

const BASE_PATH = "/ops/tv-devices";

/** searchParams の `status` を既知のステータスへ正規化する（不正値・undefined は "all" に倒す）。
 *  許可集合は STATUS_FILTERS を単一ソースにして、将来ステータスが増えても取りこぼさない。
 *  `?status=a&status=b` のような配列（Next.js が渡しうる）は先頭だけ見る。 */
function parseStatusFilter(raw: string | string[] | undefined): StatusFilter {
  const value = (Array.isArray(raw) ? raw[0] : raw) ?? "";
  return (STATUS_FILTERS as readonly string[]).includes(value) ? (value as StatusFilter) : "all";
}

/**
 * 学校スコープを保ったまま稼働ステータスのタブを切り替える href を組む。
 * `?school=` は全タブで温存し（学校を選び直させない）、既定値（status=all）はクエリに出さない。
 */
function tvDevicesHref(school: string | null, status: StatusFilter): string {
  const sp = new URLSearchParams();
  if (school !== null) {
    sp.set("school", school);
  }
  if (status !== "all") {
    sp.set("status", status);
  }
  const query = sp.toString();
  return query === "" ? BASE_PATH : `${BASE_PATH}?${query}`;
}

export default async function TvDevicesPage({
  searchParams,
}: {
  // `?school=<uuid>` で学校、`?status=down|never|quiet|online` で稼働状況を絞り込む（既定 = 全件）。
  // Server Component のまま URL クエリで状態を持つ（クライアント JS 不要・ブックマーク/共有可能）。
  searchParams: Promise<RawSearchParams>;
}) {
  const user = await requireRole(ADMIN_ROLES);
  // 設定編集は school_admin / system_admin 限定。teacher には 403 に終わる「編集」リンクを出さない
  // （死リンク防止、#494 Reviewer Low-2）。実体の認可は編集ページの requireRole + RLS が担保する。
  const canEditConfig = isRoleAllowed(user.role, TV_CONFIG_EDIT_ROLES);
  // 新規登録（オンボーディング、F15 §4.3）は cross-tenant 操作のため system_admin 限定。teacher /
  // school_admin には登録リンクを出さない（死リンク防止、実体の認可は /new ページの requireRole）。
  const canOnboard = isRoleAllowed(user.role, ONBOARDING_ROLES);

  const raw = await searchParams;
  // 学校セレクトは共通 DataList 基盤の作法（`?school=<uuid>`）に合わせる（/ops/tv-downtime と同じ）。
  // 本ページは列ソート UI を持たないので sortKeys は空 = sort/dir を URL に出さない。
  const params = parseListParams(raw, { sortKeys: [], defaultSort: "", filterKeys: ["school"] });

  // 一覧と学校セレクトの選択肢を同一 RLS context で読む。どちらも可視範囲は RLS が決める
  // （school_admin=自校 / system_admin=全校）。WHERE に school 条件は書かない（ルール2）。
  const { devices, schoolOptions } = await withSession(async (tx) => {
    const [devices, schoolOptions] = await Promise.all([listTvDevices(tx), listSchools(tx)]);
    return { devices, schoolOptions };
  });

  // 複数校が見える閲覧者（実質 system_admin）にだけ「学校」の次元を出す。自校しか見えない
  // school_admin / teacher には全行同じ値の列と選択肢 1 個のセレクトにしかならず、ノイズになる。
  // role ではなく可視データから導く（RLS が決めた可視範囲と定義上ズレない）。
  const multiSchool = schoolOptions.length > 1;
  // 不正・不可視な school は黙って「すべて」に倒す（URL は外部入力、status と同じフォールバック規律）。
  // これは**検索条件**の検証であってテナント境界ではない（越境は RLS が弾く。可視な学校だけを
  // 突き合わせ先にしているので、他校の uuid を打ち込んでも 0 件ではなく全件表示に落ちる）。
  const schoolParam = params.filters.school;
  const school =
    schoolParam !== undefined && schoolOptions.some((s) => s.id === schoolParam)
      ? schoolParam
      : null;

  // 学校で絞ってから稼働ステータスの件数を数える（「この学校で応答なしは何台？」が読めるように）。
  const scoped = school === null ? devices : devices.filter((d) => d.schoolId === school);
  // 判定基準時刻はリクエスト時刻で固定し、全行を同一 now で判定する（行ごとの揺れを避ける）。
  const now = new Date();
  const rows = scoped.map((d) => ({
    device: d,
    status: classifyTvLiveness(d.lastSeenAt, now),
  }));
  const counts: Record<StatusFilter, number> = {
    all: rows.length,
    online: rows.filter((r) => r.status === "online").length,
    quiet: rows.filter((r) => r.status === "quiet").length,
    down: rows.filter((r) => r.status === "down").length,
    never: rows.filter((r) => r.status === "never").length,
  };
  const selected = parseStatusFilter(raw.status);
  // 選択中ステータスだけに絞る（"all" は全件）。運用者の「いま応答なしの TV はどれ？」を 1 クリックで。
  const visibleRows = selected === "all" ? rows : rows.filter((r) => r.status === selected);

  return (
    <section>
      <header style={headerStyle}>
        <h1 style={titleStyle}>TV デバイス</h1>
        <span style={headerRightStyle}>
          {/* 件数は選択中の学校スコープ内の集計（学校未選択なら可視全校）。 */}
          <span style={countStyle}>
            稼働中 {counts.online} / 応答なし {counts.down} / 全 {rows.length} 台
          </span>
          {canOnboard && (
            <Link href="/ops/tv-devices/provision" style={onboardLinkStyle}>
              ＋ プロビジョン
            </Link>
          )}
          {canOnboard && (
            <Link href="/ops/tv-devices/new" style={onboardLinkStyle}>
              ＋ 新規登録
            </Link>
          )}
        </span>
      </header>
      <p style={subtitleStyle}>
        各 TV は 60 秒ごとにサーバへ設定を取りに来ます。最終ポーリング時刻から稼働状況を判定します。
      </p>

      {/* 学校で絞り込むセレクト（共通 DataList 基盤のフィルタバー。/ops/schools・/ops/tv-downtime と
          同じ作法）。設置場所ラベルは学校をまたぐと重複する（「進路指導室前」が各校にある）ため、
          全校を見る運用者が学校で切れるようにする。選択中の稼働ステータスは hidden で温存する
          （GET フォーム送信で `?status=` が消えないように）。自校しか見えない閲覧者には出さない。 */}
      {multiSchool && (
        <DataListControls
          basePath={BASE_PATH}
          params={params}
          selects={[
            {
              name: "school",
              label: "学校",
              options: schoolOptions.map((s) => ({
                value: s.id,
                label: `${s.name}（${s.prefecture}）`,
              })),
            },
          ]}
          hidden={{ status: selected === "all" ? "" : selected }}
        />
      )}

      {/* 稼働ステータスで絞り込むタブ（Server Component のまま `?status=` で状態を持つ）。要対応
          （応答なし / 未接続）を素早く拾えるよう先頭寄りに並べる。件数 0 のタブも出して全体像を保つ。
          件数・遷移先はいずれも選択中の学校スコープ内（`?school=` を保持する）。 */}
      {rows.length > 0 ? (
        <nav aria-label="稼働ステータスで絞り込み" style={filterRowStyle}>
          {STATUS_FILTERS.map((s) => {
            const isActive = s === selected;
            const label = s === "all" ? "すべて" : `${TV_STATUS_ICON[s]} ${TV_STATUS_LABEL[s]}`;
            return (
              <Link
                key={s}
                href={tvDevicesHref(school, s)}
                aria-current={isActive ? "page" : undefined}
                style={isActive ? chipActiveStyle : chipStyle}
              >
                {label}（{counts[s]}）
              </Link>
            );
          })}
        </nav>
      ) : null}

      {devices.length === 0 ? (
        <p style={emptyStyle}>登録されている TV デバイスがありません。</p>
      ) : rows.length === 0 ? (
        <p style={emptyStyle}>
          この学校に登録されている TV はありません。
          <Link href={BASE_PATH} style={{ marginLeft: "0.5rem", ...editLinkStyle }}>
            すべて表示
          </Link>
        </p>
      ) : visibleRows.length === 0 ? (
        <p style={emptyStyle}>
          この稼働ステータスに該当する TV はありません。
          {/* 学校スコープは保ったままステータス条件だけ外す（選び直させない）。 */}
          <Link
            href={tvDevicesHref(school, "all")}
            style={{ marginLeft: "0.5rem", ...editLinkStyle }}
          >
            すべて表示
          </Link>
        </p>
      ) : (
        <table style={tableStyle}>
          <caption style={captionStyle}>TV デバイスの稼働一覧</caption>
          <thead>
            <tr>
              <th scope="col" style={thLeftStyle}>
                教室ラベル
              </th>
              {/* 学校列は複数校が見える閲覧者にだけ出す（自校のみの閲覧者には全行同じ値でノイズ）。 */}
              {multiSchool && (
                <th scope="col" style={thLeftStyle}>
                  学校
                </th>
              )}
              <th scope="col" style={thLeftStyle}>
                端末ID
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
            {visibleRows.map(({ device, status }) => (
              <DeviceRow
                key={device.id}
                device={device}
                status={status}
                canEditConfig={canEditConfig}
                showSchool={multiSchool}
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
  showSchool,
}: {
  device: TvDeviceSummary;
  status: TvLivenessStatus;
  canEditConfig: boolean;
  /** 学校列を出すか（複数校が見える閲覧者のみ true。ヘッダ側の出し分けと同一条件）。 */
  showSchool: boolean;
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
      {showSchool && <td style={tdLeftStyle}>{device.schoolName}</td>}
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
            href={`/ops/tv-devices/${device.id}/history`}
            style={editLinkStyle}
            aria-label={`${device.label ?? "ラベル未設定の TV"} の稼働履歴を表示`}
          >
            履歴
          </Link>
          {canEditConfig && (
            <Link
              href={`/ops/tv-devices/${device.id}/edit`}
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
const subtitleStyle: React.CSSProperties = { color: "#6b7280", margin: "0.35rem 0 0.75rem" };
const filterRowStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "0.4rem",
  margin: "0 0 1.25rem",
};
const chipStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  padding: "0.3rem 0.7rem",
  borderRadius: "999px",
  border: "1px solid #e5e7eb",
  background: "#fff",
  color: "#374151",
  fontSize: "0.82rem",
  fontWeight: 600,
  textDecoration: "none",
  whiteSpace: "nowrap",
};
const chipActiveStyle: React.CSSProperties = {
  ...chipStyle,
  background: "#1f2937",
  borderColor: "#1f2937",
  color: "#fff",
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
