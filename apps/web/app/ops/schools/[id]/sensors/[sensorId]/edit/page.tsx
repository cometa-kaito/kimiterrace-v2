import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { maskDeviceMac } from "@/lib/sensors/status-presentation";
import { SYSTEM_ADMIN_ROLES } from "@/lib/system-admin/roles";
import { isUuid } from "@/lib/system-admin/schools-core";
import {
  getOwnSensorDevice,
  getSchoolDetail,
  listSchoolClassesForSensorForm,
} from "@kimiterrace/db";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SensorForm } from "../../../../../sensors/_components/SensorForm";

/**
 * システム管理者が**特定校**の来場検知センサー 1 台を編集する画面
 * (`/ops/schools/{id}/sensors/{sensorId}/edit`)。**Server Component**。`/ops/schools/{id}/sensors`
 * の一覧からの遷移先 (ADR-041 D3、ads `[classId]` 編集と同型)。
 *
 * **認可**: `/ops` layout の `requireRole(ADMIN_ROLES)` に加え `requireRole(SYSTEM_ADMIN_ROLES)`
 * (system_admin のみ)。
 *
 * **対象校スコープ**: 校名・存在確認は全校読取の `getSchoolDetail` で行い、不正 / 不存在 id は 404。
 * 対象センサーとクラス選択肢は `withSession(..., { tenantScoped: true, schoolId })` の**対象校 RLS tx** で
 * 取得し、actor を school_admin に降格して対象校以外を不可視にする。`getOwnSensorDevice` は RLS で可視行のみ
 * = 他校 / 不存在の id は null → **404** (越境参照を見せない)。実更新 Server Action も対象校に降格スコープして
 * 書き込む (越境防止のゲートはサーバ側)。
 *
 * 編集できるのは location_label / class_id のみ。**device_mac は変更不可** (webhook 解決キーの不変性) で
 * 末尾 4 桁マスク表示のみ。`created_by`/`updated_by` の FK 回避で system_admin は null 記録 (ADR-041 D3)。
 */
export default async function SystemSchoolSensorEditPage({
  params,
}: {
  params: Promise<{ id: string; sensorId: string }>;
}) {
  await requireRole(SYSTEM_ADMIN_ROLES);
  const { id, sensorId } = await params;
  if (!isUuid(id) || !isUuid(sensorId)) {
    notFound();
  }

  // 校名・存在確認 (system_admin の全校読取、tenantScoped なし)。不存在 / 不可視は 404。
  const detail = await withSession((tx) => getSchoolDetail(tx, id)).catch(() => null);
  if (!detail) {
    notFound();
  }
  const { school } = detail;

  // 対象校に降格スコープした tx でセンサー + クラスを読む (他校 / 不存在は null → 404)。
  const data = await withSession(
    async (tx) => {
      const sensor = await getOwnSensorDevice(tx, sensorId);
      if (!sensor) {
        return null;
      }
      const classes = await listSchoolClassesForSensorForm(tx);
      return { sensor, classes };
    },
    { tenantScoped: true, schoolId: school.id },
  );

  // センサーが対象校に存在しない (別テナント / 不存在) なら 404。
  if (!data) {
    notFound();
  }

  const basePath = `/ops/schools/${school.id}/sensors`;

  return (
    <div style={pageStyle}>
      <nav style={breadcrumbStyle} aria-label="パンくず">
        <Link href="/ops/schools" style={crumbLinkStyle}>
          学校一覧
        </Link>
        <span aria-hidden="true">/</span>
        <Link href={`/ops/schools/${school.id}`} style={crumbLinkStyle}>
          {school.name}
        </Link>
        <span aria-hidden="true">/</span>
        <Link href={basePath} style={crumbLinkStyle}>
          来場検知センサー
        </Link>
        <span aria-hidden="true">/</span>
        <span style={crumbCurrentStyle}>編集</span>
      </nav>

      <div role="note" style={bannerStyle}>
        <span aria-hidden="true">🛡</span>
        <span>
          <strong>システム管理者として「{school.name}」のセンサーを編集しています。</strong>
          <br />
          この学校のテナント範囲に限定され、すべての変更は監査ログに記録されます。
        </span>
      </div>

      <h1 style={titleStyle}>センサーを編集</h1>
      <p style={subtitleStyle}>
        設置場所ラベルと紐づくクラスを変更できます。MAC アドレスは変更できません。
      </p>
      <SensorForm
        classes={data.classes}
        schoolId={school.id}
        backHref={basePath}
        initial={{
          id: data.sensor.id,
          maskedMac: maskDeviceMac(data.sensor.deviceMac),
          locationLabel: data.sensor.locationLabel,
          classId: data.sensor.classId,
        }}
      />
    </div>
  );
}

const pageStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: "1rem" };
const breadcrumbStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  fontSize: "0.85rem",
  color: "#6b7280",
  flexWrap: "wrap",
};
const crumbLinkStyle: React.CSSProperties = { color: "#2563eb", textDecoration: "none" };
const crumbCurrentStyle: React.CSSProperties = { color: "#1c1917" };
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
const titleStyle: React.CSSProperties = { fontSize: "1.4rem", fontWeight: 700, margin: 0 };
const subtitleStyle: React.CSSProperties = { color: "#6b7280", fontSize: "0.9rem", margin: 0 };
