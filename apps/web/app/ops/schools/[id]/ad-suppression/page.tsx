import { Breadcrumb } from "@/app/_components/Breadcrumb";
import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { parseAdSuppression } from "@/lib/signage/ad-suppression";
import { SYSTEM_ADMIN_ROLES } from "@/lib/system-admin/roles";
import { isUuid } from "@/lib/system-admin/schools-core";
import { getSchoolConfigValue, getSchoolDetail } from "@kimiterrace/db";
import { notFound } from "next/navigation";
import { AdSuppressionManager } from "./_components/AdSuppressionManager";

/**
 * システム管理者が**特定校の授業時間（広告停止）**を設定する画面（`/ops/schools/{id}/ad-suppression`）。
 * **Server Component**。学校ごとの「授業時間帯」を設定すると、その時間帯はサイネージ盤面の**広告枠だけ**を
 * 空にする（時間割・連絡・提出物など他ブロックは通常どおり表示）。実機端末は既存ポーリングで追従する。
 *
 * **認可**: `/ops` layout の `requireRole(ADMIN_ROLES)` に加え `requireRole(SYSTEM_ADMIN_ROLES)`
 * （system_admin のみ）。静粛時間（クラス単位）と違い、授業時間は**学校単位**なのでクラス選択は挟まない
 * （設定は `school_configs` scope='school', kind='display_settings' の `value.adSuppression` に相乗り）。
 *
 * **対象校スコープ**: 既存値は `withSession({ tenantScoped: true, schoolId })` の対象校 RLS tx で読み、
 * actor（system_admin）を school_admin に降格して対象校以外を不可視にする（quiet-hours /ops と同型）。校名・
 * 存在確認は全校読取の `getSchoolDetail`。不正 / 不存在 id は 404。
 */
export default async function SystemSchoolAdSuppressionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireRole(SYSTEM_ADMIN_ROLES);
  const { id } = await params;
  if (!isUuid(id)) {
    notFound();
  }

  // 校名・存在確認（system_admin の全校読取、tenantScoped なし）。不存在 / 不可視は 404。
  const detail = await withSession((tx) => getSchoolDetail(tx, id)).catch(() => null);
  if (!detail) {
    notFound();
  }
  const { school } = detail;

  // 対象校に降格スコープした tx で display_settings を読み、adSuppression を defensive にパースする。
  const config = await withSession((tx) => getSchoolConfigValue(tx, "display_settings"), {
    tenantScoped: true,
    schoolId: school.id,
  }).catch(() => null);
  const suppression = parseAdSuppression(config);

  return (
    <div style={pageStyle}>
      <Breadcrumb
        items={[
          { label: "学校一覧", href: "/ops/schools" },
          { label: school.name, href: `/ops/schools/${school.id}` },
          { label: "授業時間（広告停止）" },
        ]}
      />

      <div role="note" style={bannerStyle}>
        <span aria-hidden="true">🛡</span>
        <span>
          <strong>
            システム管理者として「{school.name}」の授業時間（広告停止）を編集しています。
          </strong>
          <br />
          この学校のテナント範囲に限定され、すべての変更は監査ログに記録されます。
        </span>
      </div>

      <h1 style={titleStyle}>授業時間（広告停止）</h1>
      <p style={subtitleStyle}>
        設定した授業時間帯は、サイネージの広告枠だけを非表示にします（時間割・連絡・提出物などは通常どおり
        表示され、休み時間や放課後は広告が出ます）。設定はこの学校のすべてのモニタに適用され、実機は自動で
        追従します。
      </p>
      <AdSuppressionManager
        schoolId={school.id}
        initialEnabled={suppression.enabled}
        initialRanges={suppression.ranges}
        initialWeekdays={suppression.weekdays}
      />
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
const titleStyle: React.CSSProperties = { fontSize: "1.4rem", fontWeight: 700, margin: 0 };
const subtitleStyle: React.CSSProperties = {
  color: "#6b7280",
  fontSize: "0.9rem",
  margin: 0,
  lineHeight: 1.6,
};
