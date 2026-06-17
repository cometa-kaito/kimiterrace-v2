import { AdsManager } from "@/app/app/editor/[classId]/ads/_components/AdsManager";
import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { SYSTEM_ADMIN_ROLES } from "@/lib/system-admin/roles";
import { isUuid } from "@/lib/system-admin/schools-core";
import {
  findVisibleClass,
  getEffectiveAdsForClass,
  getSchoolDetail,
  listClassOwnAds,
} from "@kimiterrace/db";
import Link from "next/link";
import { notFound } from "next/navigation";

/**
 * システム管理者が**特定校の特定クラス**の広告を編集する画面 (`/ops/schools/{id}/ads/{classId}`)。
 * **Server Component**。`/ops/schools/{id}/ads` のクラス選択 (#46) からの遷移先。
 *
 * **認可**: `/ops` layout の `requireRole(ADMIN_ROLES)` に加え `requireRole(SYSTEM_ADMIN_ROLES)`
 * (system_admin のみ。school_admin は自校の `/app/editor/{classId}/ads` を使う)。
 *
 * **対象校スコープ (ADR-019 §#95 / hub #998・#999 と同型)**: 一覧データは
 * `withSession(..., { tenantScoped: true, schoolId })` の**対象校 RLS tx** で取得し、actor (system_admin)
 * を tx 内で school_admin に降格して対象校以外を不可視にする。編集 UI (`AdsManager`) には `schoolId` を
 * 渡し、各 Server Action を対象校に結ぶ (越境防止のゲートはサーバ側 `toAdsActor`/`withSession`)。
 * 校名・存在確認は全校読取の `getSchoolDetail` で行い、不正 / 不存在 id は 404。
 */
export default async function SystemSchoolClassAdsPage({
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

  // 対象校に降格スコープした tx でクラス + 広告を読む (他校は不可視 → クラスは not found 扱い)。
  const data = await withSession(
    async (tx) => {
      const cls = await findVisibleClass(tx, classId);
      if (!cls) {
        return null;
      }
      const ownAds = await listClassOwnAds(tx, classId);
      // 継承広告 (親階層由来 = is_inherited) のみ read-only 表示に使う (自クラス分は ownAds で編集)。
      const effective = await getEffectiveAdsForClass(tx, classId);
      const inherited = effective.filter((a) => a.isInherited);
      return { className: cls.name, ownAds, inherited };
    },
    { tenantScoped: true, schoolId: school.id },
  );

  // クラスが対象校に存在しない (別テナント / 不存在) なら 404。
  if (!data) {
    notFound();
  }

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
        <Link href={`/ops/schools/${school.id}/ads`} style={crumbLinkStyle}>
          広告掲載
        </Link>
        <span aria-hidden="true">/</span>
        <span style={crumbCurrentStyle}>{data.className}</span>
      </nav>

      <div role="note" style={bannerStyle}>
        <span aria-hidden="true">🛡</span>
        <span>
          <strong>
            システム管理者として「{school.name}」{data.className} の広告を編集しています。
          </strong>
          <br />
          この学校のテナント範囲に限定され、すべての追加・変更・削除は監査ログに記録されます。
        </span>
      </div>

      <h1 style={titleStyle}>{data.className} の広告</h1>
      <p style={subtitleStyle}>
        このクラスに表示される広告を管理します。学校 / 学科 / 学年から継承された広告は参照のみです。
      </p>
      <AdsManager
        scope="class"
        targetId={classId}
        schoolId={school.id}
        ownLabel="このクラス"
        ownAds={data.ownAds}
        inherited={data.inherited.map((a) => ({
          adId: a.adId,
          sourceScope: a.sourceScope,
          mediaUrl: a.mediaUrl,
          mediaType: a.mediaType,
          durationSec: a.durationSec,
          caption: a.caption,
          displayOrder: a.displayOrder,
        }))}
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
