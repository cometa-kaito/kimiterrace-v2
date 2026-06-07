import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { ADS_ROLES } from "@/lib/school-admin/ads-core";
import { findVisibleClass, getEffectiveAdsForClass, listClassOwnAds } from "@kimiterrace/db";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AdsManager } from "./_components/AdsManager";

/**
 * クラス別 広告管理 (#48-J)。指定クラスの**自クラススコープ広告**の一覧 + 追加 / 編集 / 削除と、
 * 親階層 (学校 / 学科 / 学年) から継承される広告の **read-only 文脈表示**。
 *
 * `/admin` 配下 (#48-C layout で認証) + 本ページで `ADS_ROLES` (school_admin / system_admin) に限定
 * (teacher は 403 → /forbidden)。別テナントのクラスは RLS 不可視 → 404。
 *
 * 自クラス広告は `ads` テーブルから (`listClassOwnAds`)、継承広告は `effective_ads_per_class` VIEW から
 * (`getEffectiveAdsForClass` の `is_inherited=true` 行) 取得する。両方を 1 つの `withSession` の自校
 * RLS tx 内でまとめて読み、クライアント編集器に渡す。
 */
export default async function ClassAdsPage({ params }: { params: Promise<{ classId: string }> }) {
  const user = await requireRole(ADS_ROLES);
  const { classId } = await params;

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
      // tenantScoped: system_admin を降格し full_access policy の全校発火を止める (他校 class の可視化を防ぐ、
      // ADR-019 §#95)。write 側 (ads-actions) と同規律で read も自校に限定する。
    },
    { tenantScoped: true },
  );

  // クラスが自校で不可視 (別テナント / 存在しない) なら 404。
  if (!data) {
    notFound();
  }

  // 戻り導線は role 別: system_admin はエディタ (EDITOR_ROLES=teacher/school_admin) に 403 になるため
  // 学校一覧へ戻す。school_admin はこのクラスの編集へ戻る。
  const backHref =
    user.role === "system_admin" ? "/admin/system/schools" : `/admin/editor/${classId}`;
  const backLabel =
    user.role === "system_admin" ? "学校一覧へ戻る" : `${data.className} の編集へ戻る`;

  return (
    <div>
      <Link href={backHref} style={{ fontSize: "0.85rem", color: "#2563eb" }}>
        ← {backLabel}
      </Link>
      <h1 style={{ fontSize: "1.4rem", margin: "0.5rem 0 0.25rem" }}>{data.className} の広告</h1>
      <p style={{ color: "#6b7280", margin: "0 0 1rem", fontSize: "0.9rem" }}>
        このクラスに表示される広告を管理します。学校 / 学科 / 学年から継承された広告は参照のみです。
      </p>
      <AdsManager
        scope="class"
        targetId={classId}
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
