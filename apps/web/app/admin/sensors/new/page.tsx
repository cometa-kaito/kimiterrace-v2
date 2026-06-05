import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { SYSTEM_ADMIN_ROLES } from "@/lib/system-admin/roles";
import { listSchoolClassesForSensorForm } from "@kimiterrace/db";
import { SensorForm } from "../_components/SensorForm";

/**
 * F13 (#391, ADR-020): 来場検知センサーの **新規登録**フォームページ `/admin/sensors/new`。**Server Component**。
 *
 * **認可（校務DX原則: 監視系は運営専用）**: センサー管理は学校側の校務を楽にする機能ではないため、
 * 一覧 (`/admin/sensors`) と同じく本ページも `requireRole(SYSTEM_ADMIN_ROLES)`（system_admin のみ）に
 * 締める。teacher / school_admin は nav から撤去済み + ここで 403 → /forbidden。
 *
 * クラス選択肢は `withSession` の RLS context で取得する (`classes` の tenant_isolation /
 * system_admin_full_access)。登録の実体は Server Action (`createSensorDeviceAction`) で、こちらは school_id
 * を持つ自校 actor を要する設計のため system_admin は実登録できない（運営は当面 read 中心。実害は無い）。
 */
export default async function NewSensorPage() {
  await requireRole(SYSTEM_ADMIN_ROLES);
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
