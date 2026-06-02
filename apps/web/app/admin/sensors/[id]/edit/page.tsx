import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { SENSOR_WRITE_ROLES } from "@/lib/sensors/mutations-core";
import { maskDeviceMac } from "@/lib/sensors/status-presentation";
import { getOwnSensorDevice, listSchoolClassesForSensorForm } from "@kimiterrace/db";
import { notFound } from "next/navigation";
import { SensorForm } from "../../_components/SensorForm";

/**
 * F13 (#391, ADR-020): 来場検知センサーの **編集**フォームページ `/admin/sensors/[id]/edit`。
 * **Server Component**。
 *
 * #485/#486 が defer した mutation スライスの edit 側。認可は **school_admin のみ**
 * (`SENSOR_WRITE_ROLES`、teacher は 403)。対象センサーと自校クラスを 1 つの `withSession` 自校 RLS tx で
 * 取得する。`getOwnSensorDevice` は RLS の tenant_isolation で自校行のみ可視 = 他校/不存在の id は null →
 * **404** (越境参照を見せない、ads ページの notFound と同方針)。
 *
 * 編集できるのは location_label / class_id のみ。**device_mac は変更不可** (webhook 解決キーの不変性) で
 * 末尾 4 桁マスク表示のみ。実更新は Server Action (`updateSensorDeviceAction`) + RLS が担保する。
 */
export default async function EditSensorPage({ params }: { params: Promise<{ id: string }> }) {
  await requireRole(SENSOR_WRITE_ROLES);
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
