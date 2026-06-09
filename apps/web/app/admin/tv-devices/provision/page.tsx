import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { ONBOARDING_ROLES } from "@/lib/tv/onboarding-core";
import { listClassesWithSchool, listSchools } from "@kimiterrace/db";
import Link from "next/link";
import { ProvisionForm } from "./_components/ProvisionForm";

/**
 * C方式 TV プロビジョニング（`/admin/tv-devices/provision`）。**Server Component**。
 *
 * **認可**: プロビジョニングは cross-tenant（任意校に設置）+ device 登録 + signage 発行を伴うため
 * **system_admin 限定**（`ONBOARDING_ROLES`）。`requireRole` で teacher / school_admin を /forbidden に弾く。
 *
 * 設置先の選択肢（全校 + 全クラス）を `withSession` の RLS context で読む（system_admin_full_access が全校を
 * 可視に、手書き WHERE は書かない、ルール2）。フォーム（Client）には最小射影だけ渡し、school→class の
 * カスケードは client 側で行う。
 */
export default async function ProvisionPage() {
  await requireRole(ONBOARDING_ROLES);
  const { schools, classes } = await withSession(
    async (tx) => ({
      schools: await listSchools(tx),
      classes: await listClassesWithSchool(tx),
    }),
    { allowedRoles: ONBOARDING_ROLES },
  );
  const schoolOptions = schools.map((s) => ({
    id: s.id,
    name: s.name,
    prefecture: s.prefecture,
  }));
  const classOptions = classes.map((c) => ({ id: c.id, name: c.name, schoolId: c.schoolId }));

  return (
    <section style={{ maxWidth: "640px" }}>
      <p style={{ margin: "0 0 0.75rem" }}>
        <Link href="/admin/tv-devices" style={{ color: "#1d4ed8", fontSize: "0.85rem" }}>
          ← TV デバイス一覧へ戻る
        </Link>
      </p>
      <h1 style={{ fontSize: "1.3rem", fontWeight: 700, margin: "0 0 0.25rem" }}>
        TV プロビジョニング（C方式）
      </h1>
      <p style={{ color: "#6b7280", margin: "0 0 1.25rem", fontSize: "0.9rem" }}>
        設置先・スケジュールを入力して「プロビジョン」を押すと、TV デバイスを事前作成して
        signage_url を発行し、 現地ノート PC の <code>provision-agent</code> が claim
        するジョブを作成します。工場リセットと県 Wi-Fi
        の再設定（物理作業）はジョブの「awaiting_physical」段階で具体手順を提示します。
      </p>
      {schoolOptions.length === 0 ? (
        <p style={{ color: "#b91c1c" }}>
          登録できる学校がありません。先に学校マスタを登録してください。
        </p>
      ) : (
        <ProvisionForm schools={schoolOptions} classes={classOptions} />
      )}
    </section>
  );
}
