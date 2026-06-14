import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { maskDeviceMac } from "@/lib/sensors/status-presentation";
import { SYSTEM_ADMIN_ROLES } from "@/lib/system-admin/roles";
import { getOwnSensorDevice, listSchoolClassesForSensorForm } from "@kimiterrace/db";
import { notFound } from "next/navigation";
import { SensorForm } from "../../_components/SensorForm";

/**
 * F13 (#391, ADR-020): 来場検知センサーの **編集**フォームページ `/ops/sensors/[id]/edit`。
 * **Server Component**。
 *
 * **認可（校務DX原則: 監視系は運営専用）**: 一覧 / 登録と同じく本ページも `requireRole(SYSTEM_ADMIN_ROLES)`
 * （system_admin のみ）に締める。teacher / school_admin は nav から撤去済み + ここで 403。対象センサーと
 * クラスを 1 つの `withSession` RLS tx で取得する。`getOwnSensorDevice` は RLS（tenant_isolation /
 * system_admin_full_access）で可視行のみ = 不可視/不存在の id は null → **404**（越境参照を見せない、ads
 * ページの notFound と同方針）。実更新 Server Action は自校 actor を要するため system_admin は実編集しない。
 *
 * 編集できるのは location_label / class_id のみ。**device_mac は変更不可** (webhook 解決キーの不変性) で
 * 末尾 4 桁マスク表示のみ。実更新は Server Action (`updateSensorDeviceAction`) + RLS が担保する。
 */
export default async function EditSensorPage({ params }: { params: Promise<{ id: string }> }) {
  await requireRole(SYSTEM_ADMIN_ROLES);
  const { id } = await params;

  const data = await withSession(async (tx) => {
    const sensor = await getOwnSensorDevice(tx, id);
    if (!sensor) {
      return null;
    }
    const classes = await listSchoolClassesForSensorForm(tx);
    return { sensor, classes };
  });

  // 自校で不可視（他校 / 存在しない）なら 404。
  if (!data) {
    notFound();
  }

  return (
    <section>
      <h1 style={{ fontSize: "1.3rem", fontWeight: 700, margin: "0 0 0.35rem" }}>センサーを編集</h1>
      <p style={{ color: "#6b7280", margin: "0 0 1.25rem", fontSize: "0.9rem" }}>
        設置場所ラベルと紐づくクラスを変更できます。MAC アドレスは変更できません。
      </p>
      <SensorForm
        classes={data.classes}
        initial={{
          id: data.sensor.id,
          maskedMac: maskDeviceMac(data.sensor.deviceMac),
          locationLabel: data.sensor.locationLabel,
          classId: data.sensor.classId,
        }}
      />
    </section>
  );
}
