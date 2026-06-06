import { type TenantTx, ads, schools } from "@kimiterrace/db";
import { desc, eq } from "drizzle-orm";

/**
 * F10 / #46: **運営側広告 CRM** — 広告主に紐づく広告（`ads.advertiser_id = advertiserId`）の一覧。
 *
 * 運営 (system_admin) が広告主配下で入稿した広告（scope='school'＝対象校の全クラスに表示）を管理画面に
 * 出すために使う。学校 (school_admin) が自校で作るクラス広告は `advertiser_id = null` なので**含まれない**。
 *
 * **テナント境界は RLS が担保（ルール2）**: 本関数は **system_admin の RLS（system_admin_full_access）下で
 * 呼ぶ前提**で、`advertiser_id` で絞るのは対象広告主の特定（越境防止でない）。表示用に対象校名を join する。
 */
export type AdvertiserAd = {
  adId: string;
  schoolId: string;
  schoolName: string;
  scope: string;
  mediaUrl: string;
  mediaType: string;
  durationSec: number;
  linkUrl: string | null;
  caption: string | null;
};

export async function listAdvertiserAds(
  tx: TenantTx,
  advertiserId: string,
): Promise<AdvertiserAd[]> {
  return tx
    .select({
      adId: ads.id,
      schoolId: ads.schoolId,
      schoolName: schools.name,
      scope: ads.scope,
      mediaUrl: ads.mediaUrl,
      mediaType: ads.mediaType,
      durationSec: ads.durationSec,
      linkUrl: ads.linkUrl,
      caption: ads.caption,
    })
    .from(ads)
    .innerJoin(schools, eq(ads.schoolId, schools.id))
    .where(eq(ads.advertiserId, advertiserId))
    .orderBy(desc(ads.createdAt));
}
