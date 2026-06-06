import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { ONBOARDING_ROLES } from "@/lib/tv/onboarding-core";
import { listSchools } from "@kimiterrace/db";
import Link from "next/link";
import { TvDeviceCreateForm } from "./_components/TvDeviceCreateForm";

/**
 * F15 §4.3 (ADR-022): TV デバイス新規登録（`/admin/tv-devices/new`）。**Server Component**。
 *
 * **認可**: 新規登録は cross-tenant（任意校に設置）でテナント外操作のため **system_admin 限定**
 * （`ONBOARDING_ROLES`、編集の TV_CONFIG_EDIT_ROLES より狭い）。`requireRole` で teacher / school_admin を
 * /forbidden に弾く（ルール2 の role 境界第一層、実体の認可は Server Action 側も再 gate）。
 *
 * 設置先の選択肢として全校を `listSchools` で読む。system_admin の RLS context（system_admin_full_access）が
 * 全校を可視にする（手書き WHERE は書かない、ルール2）。フォーム（Client）に school の最小射影だけを渡す。
 */
export default async function NewTvDevicePage() {
  await requireRole(ONBOARDING_ROLES);
  const schools = await withSession((tx) => listSchools(tx), {
    allowedRoles: ONBOARDING_ROLES,
  });
  const options = schools.map((s) => ({
    id: s.id,
    name: s.name,
    prefecture: s.prefecture,
  }));

  return (
    <section style={{ maxWidth: "640px" }}>
      <p style={{ margin: "0 0 0.75rem" }}>
        <Link href="/admin/tv-devices" style={{ color: "#1d4ed8", fontSize: "0.85rem" }}>
          ← TV デバイス一覧へ戻る
        </Link>
      </p>
      <h1 style={{ fontSize: "1.3rem", fontWeight: 700, margin: "0 0 0.25rem" }}>
        TV デバイスの新規登録
      </h1>
      <p style={{ color: "#6b7280", margin: "0 0 1.25rem", fontSize: "0.9rem" }}>
        設置先の学校と設定を登録します。device_id は TV
        が初回起動時に生成した値を入力するか、空欄にすると自動で採番します。登録後に表示される
        device_id を TV 側に設定してください。
      </p>
      {options.length === 0 ? (
        <p style={{ color: "#b91c1c" }}>
          登録できる学校がありません。先に学校マスタを登録してください。
        </p>
      ) : (
        <TvDeviceCreateForm schools={options} />
      )}
    </section>
  );
}
