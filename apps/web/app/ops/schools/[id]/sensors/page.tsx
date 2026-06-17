import { Breadcrumb } from "@/app/_components/Breadcrumb";
import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { maskDeviceMac, presentSensorStatus } from "@/lib/sensors/status-presentation";
import { SYSTEM_ADMIN_ROLES } from "@/lib/system-admin/roles";
import { isUuid } from "@/lib/system-admin/schools-core";
import {
  getSchoolDetail,
  listSchoolClassesForSensorForm,
  listSensorDeviceStatuses,
} from "@kimiterrace/db";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SensorForm } from "../../../sensors/_components/SensorForm";

/**
 * システム管理者が**特定校**の来場検知センサーを登録・編集する画面 (`/ops/schools/{id}/sensors`)。
 * **Server Component**。ADR-041 D3 で「センサーは school_admin 限定」を覆し、運営が特定校スコープで
 * センサーを設置代行できるようにした (ads/quiet_hours/editor #1002/#1003/#1009 と同型)。
 *
 * **認可**: `/ops` layout の `requireRole(ADMIN_ROLES)` に加え `requireRole(SYSTEM_ADMIN_ROLES)`
 * (system_admin のみ。school_admin は自校の経路を使う)。全校横断の読取一覧は別途 `/ops/sensors`。
 *
 * **対象校スコープ (ADR-019 §#95 / hub #998・#999 と同型)**: 校名・存在確認は全校読取の
 * `getSchoolDetail` (tenantScoped なし) で行い、不正 / 不存在 id は 404。一覧 (`listSensorDeviceStatuses`)
 * とクラス選択肢 (`listSchoolClassesForSensorForm`) は `withSession(..., { tenantScoped: true, schoolId })`
 * の**対象校 RLS tx** で取得し、actor (system_admin) を tx 内で school_admin に降格して対象校以外を不可視に
 * する。登録フォーム (`SensorForm`) には `schoolId` を渡し、各 Server Action を対象校に結ぶ (越境防止の
 * ゲートはサーバ側 `toSensorActor`/`withSession`)。
 *
 * **公開透明性 (ADR-020)**: 来場検知は PIR センサーでカメラ非使用。「カメラ不使用」を明示する。
 * **PII 非格納 (ルール4)**: device_mac は末尾 4 桁マスク、`location_label` は教室名等のみ (生徒名等を入れない)。
 */
export default async function SystemSchoolSensorsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireRole(SYSTEM_ADMIN_ROLES);
  const { id } = await params;
  if (!isUuid(id)) {
    notFound();
  }

  // 校名・存在確認 (system_admin の全校読取、tenantScoped なし)。不存在 / 不可視は 404。
  const detail = await withSession((tx) => getSchoolDetail(tx, id)).catch(() => null);
  if (!detail) {
    notFound();
  }
  const { school } = detail;

  // 対象校に降格スコープした tx でセンサー一覧 + クラス選択肢を読む (他校は不可視)。
  const data = await withSession(
    async (tx) => {
      const sensors = await listSensorDeviceStatuses(tx);
      const classes = await listSchoolClassesForSensorForm(tx);
      return { sensors, classes };
    },
    { tenantScoped: true, schoolId: school.id },
  );

  const basePath = `/ops/schools/${school.id}/sensors`;

  return (
    <div style={pageStyle}>
      <Breadcrumb
        items={[
          { label: "学校一覧", href: "/ops/schools" },
          { label: school.name, href: `/ops/schools/${school.id}` },
          { label: "来場検知センサー" },
        ]}
      />

      <div role="note" style={bannerStyle}>
        <span aria-hidden="true">🛡</span>
        <span>
          <strong>システム管理者として「{school.name}」の来場検知センサーを編集しています。</strong>
          <br />
          この学校のテナント範囲に限定され、すべての追加・変更は監査ログに記録されます。
        </span>
      </div>

      <header style={headerStyle}>
        <h1 style={titleStyle}>{school.name} の来場検知センサー</h1>
        <span
          style={cameraBadgeStyle}
          title="来場検知は人感(PIR)センサーのみ。カメラ・録画は使用しません。"
        >
          カメラ不使用
        </span>
      </header>
      <p style={subtitleStyle}>
        この学校に登録された SwitchBot
        人感（PIR）センサーの一覧です。各センサーの設置場所・紐づくクラス・
        稼働状態を確認し、設置場所やクラスを編集できます。下のフォームから新規登録もできます。
      </p>

      <section>
        <h2 style={sectionTitleStyle}>登録済みセンサー ({data.sensors.length})</h2>
        {data.sensors.length === 0 ? (
          <p style={emptyStyle}>
            まだセンサーが登録されていません。下のフォームから登録してください。
          </p>
        ) : (
          <ul style={listStyle}>
            {data.sensors.map((s) => {
              const presentation = presentSensorStatus(s.status);
              const decommissioned = s.decommissionedAt != null;
              return (
                <li key={s.id} style={itemStyle}>
                  <span style={itemMainStyle}>
                    <strong>{s.locationLabel ?? "（設置場所 未設定）"}</strong>
                    <span style={monoStyle} title="末尾 4 桁のみ表示（擬似識別子）">
                      {maskDeviceMac(s.deviceMac)}
                    </span>
                    <span style={metaStyle}>クラス: {s.className ?? "—"}</span>
                    <span
                      style={{
                        ...statusBadgeStyle,
                        color: presentation.color,
                        background: presentation.background,
                      }}
                    >
                      <span aria-hidden="true">{presentation.symbol}</span>
                      {presentation.label}
                    </span>
                    {decommissioned ? <span style={metaStyle}>撤去済み</span> : null}
                  </span>
                  <Link
                    href={`${basePath}/${s.id}/edit`}
                    style={manageLinkStyle}
                    prefetch={false}
                    aria-label={`${s.locationLabel ?? "未設定のセンサー"}を編集`}
                  >
                    編集 →
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section>
        <h2 style={sectionTitleStyle}>センサーを登録</h2>
        <p style={subtitleStyle}>
          MAC アドレスはこのサービス全体で一意です（既に登録済みの MAC は登録できません）。
        </p>
        <SensorForm classes={data.classes} schoolId={school.id} backHref={basePath} />
      </section>
    </div>
  );
}

const pageStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: "1rem" };
const bannerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: "0.6rem",
  background: "#fef9c3",
  border: "1px solid #fde68a",
  borderRadius: "8px",
  padding: "0.75rem 0.9rem",
  fontSize: "0.85rem",
  lineHeight: 1.6,
  color: "#854d0e",
};
const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
  flexWrap: "wrap",
};
const titleStyle: React.CSSProperties = { fontSize: "1.4rem", fontWeight: 700, margin: 0 };
const cameraBadgeStyle: React.CSSProperties = {
  fontSize: "0.7rem",
  fontWeight: 600,
  color: "#166534",
  background: "#dcfce7",
  border: "1px solid #bbf7d0",
  borderRadius: "999px",
  padding: "0.15rem 0.6rem",
};
const subtitleStyle: React.CSSProperties = { color: "#6b7280", fontSize: "0.9rem", margin: 0 };
const sectionTitleStyle: React.CSSProperties = {
  fontSize: "1.05rem",
  fontWeight: 700,
  margin: "0 0 0.6rem",
};
const listStyle: React.CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: "0.5rem",
};
const itemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "1rem",
  padding: "0.6rem 0.9rem",
  border: "1px solid #e5e7eb",
  borderRadius: "8px",
  background: "#fff",
};
const itemMainStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
  flexWrap: "wrap",
};
const monoStyle: React.CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  color: "#374151",
  fontSize: "0.85rem",
};
const metaStyle: React.CSSProperties = { color: "#9ca3af", fontSize: "0.8rem" };
const statusBadgeStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.35rem",
  fontSize: "0.72rem",
  fontWeight: 600,
  padding: "0.1rem 0.55rem",
  borderRadius: "999px",
  whiteSpace: "nowrap",
};
const manageLinkStyle: React.CSSProperties = {
  fontSize: "0.9rem",
  color: "#1d4ed8",
  whiteSpace: "nowrap",
};
const emptyStyle: React.CSSProperties = { color: "#9ca3af", fontSize: "0.85rem", margin: 0 };
