import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { SENSOR_WRITE_ROLES } from "@/lib/sensors/mutations-core";
import { listSchoolClassesForSensorForm } from "@kimiterrace/db";
import { SensorForm } from "../_components/SensorForm";

/**
 * F13 (#391, ADR-020): 来場検知センサーの **新規登録**フォームページ `/admin/sensors/new`。**Server Component**。
 *
 * #485/#486 が defer した mutation スライスの register 側。認可は **school_admin のみ**
 * (`SENSOR_WRITE_ROLES`、teacher は read 専用なので 403 → /forbidden)。一覧 `/admin/sensors`
 * (read は PUBLISHER_ROLES) よりロールを絞る (操作系の認可第一層、ルール2 多層防御)。
 *
 * クラス選択肢は `withSession` の自校 RLS context で取得する (`classes` の tenant_isolation が他校を弾く)。
 * 登録の実体は Server Action (`createSensorDeviceAction`) + RLS の WITH CHECK + device_mac グローバル一意。
 */
export default async function NewSensorPage() {
  await requireRole(SENSOR_WRITE_ROLES);
  const classes = await withSession((tx) => listSchoolClassesForSensorForm(tx));

  return (
    <section>
      <h1 style={{ fontSize: "1.3rem", fontWeight: 700, margin: "0 0 0.35rem" }}>センサーを登録</h1>
      <p style={{ color: "#6b7280", margin: "0 0 1.25rem", fontSize: "0.9rem" }}>
        SwitchBot 人感（PIR）センサーを自校に登録します。MAC
        アドレスはこのサービス全体で一意です（既に 登録済みの MAC は登録できません）。
      </p>
      <SensorForm classes={classes} />
    </section>
  );
}
