import { Breadcrumb } from "@/app/_components/Breadcrumb";
import { QuietHoursManager } from "@/app/app/editor/[classId]/quiet-hours/_components/QuietHoursManager";
import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { QUIET_HOURS_KIND, readQuietRanges } from "@/lib/school-admin/quiet-hours-core";
import { SYSTEM_ADMIN_ROLES } from "@/lib/system-admin/roles";
import { isUuid } from "@/lib/system-admin/schools-core";
import { findVisibleClass, getClassConfigValue, getSchoolDetail } from "@kimiterrace/db";
import { notFound } from "next/navigation";

/**
 * システム管理者が**特定校の特定クラス**の静粛時間を編集する画面
 * (`/ops/schools/{id}/quiet-hours/{classId}`)。**Server Component**。
 * `/ops/schools/{id}/quiet-hours` のクラス選択からの遷移先 (広告 #1002 の `[classId]` ページと対称)。
 *
 * **認可**: `/ops` layout の `requireRole(ADMIN_ROLES)` に加え `requireRole(SYSTEM_ADMIN_ROLES)`
 * (system_admin のみ。school_admin は自校の `/app/editor/{classId}/quiet-hours` を使う)。
 *
 * **対象校スコープ (ADR-019 §#95 / hub #998・#999 / ads #1002 と同型)**: 既存値は
 * `withSession(..., { tenantScoped: true, schoolId })` の**対象校 RLS tx** で取得し、actor (system_admin)
 * を tx 内で school_admin に降格して対象校以外を不可視にする。編集 UI (`QuietHoursManager`) には `schoolId`
 * を渡し、Server Action を対象校に結ぶ (越境防止のゲートはサーバ側 `toQuietHoursActor`/`withSession`)。
 * 校名・存在確認は全校読取の `getSchoolDetail` で行い、不正 / 不存在 id は 404。
 */
export default async function SystemSchoolClassQuietHoursPage({
  params,
}: {
  params: Promise<{ id: string; classId: string }>;
}) {
  await requireRole(SYSTEM_ADMIN_ROLES);
  const { id, classId } = await params;
  if (!isUuid(id) || !isUuid(classId)) {
    notFound();
  }

  // 校名・存在確認 (system_admin の全校読取、tenantScoped なし)。不存在 / 不可視は 404。
  const detail = await withSession((tx) => getSchoolDetail(tx, id)).catch(() => null);
  if (!detail) {
    notFound();
  }
  const { school } = detail;

  // 対象校に降格スコープした tx でクラス + 既存静粛時間を読む (他校は不可視 → クラスは not found 扱い)。
  const data = await withSession(
    async (tx) => {
      const cls = await findVisibleClass(tx, classId);
      if (!cls) {
        return null;
      }
      const value = await getClassConfigValue(tx, classId, QUIET_HOURS_KIND);
      return { className: cls.name, ranges: readQuietRanges(value) };
    },
    { tenantScoped: true, schoolId: school.id },
  );

  // クラスが対象校に存在しない (別テナント / 不存在) なら 404。
  if (!data) {
    notFound();
  }

  return (
    <div style={pageStyle}>
      <Breadcrumb
        items={[
          { label: "学校一覧", href: "/ops/schools" },
          { label: school.name, href: `/ops/schools/${school.id}` },
          { label: "静粛時間", href: `/ops/schools/${school.id}/quiet-hours` },
          { label: data.className },
        ]}
      />

      <div role="note" style={bannerStyle}>
        <span aria-hidden="true">🛡</span>
        <span>
          <strong>
            システム管理者として「{school.name}」{data.className} の静粛時間を編集しています。
          </strong>
          <br />
          この学校のテナント範囲に限定され、すべての変更は監査ログに記録されます。
        </span>
      </div>

      <h1 style={titleStyle}>{data.className} の静粛時間</h1>
      <p style={subtitleStyle}>
        サイネージを静音 /
        非表示にする時間帯を設定します。設定した時間帯はサイネージ表示に反映されます。
      </p>
      <QuietHoursManager
        scope="class"
        targetId={classId}
        schoolId={school.id}
        initialRanges={data.ranges}
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
const subtitleStyle: React.CSSProperties = { color: "#6b7280", fontSize: "0.9rem", margin: 0 };
