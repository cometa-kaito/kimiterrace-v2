import { and, asc, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { adTargetMonitors } from "../schema/ad-target-monitors.js";
import { ads } from "../schema/ads.js";
import { effectiveAdsPerClass } from "../schema/effective-ads-view.js";

/** `effective_ads_per_class` VIEW の 1 行 (= あるクラスの実効広告 1 件)。 */
export type EffectiveAd = typeof effectiveAdsPerClass.$inferSelect;

/**
 * モニタ（端末）に表示する実効広告 1 件。`EffectiveAd` から `classId` を除いた形（モニタ起点なので
 * クラス非依存・廊下等の class なしモニタでも成立する）。クラス継承広告とモニタ直指定広告を統一して扱う。
 * `sourceScope='monitor'` がモニタ直指定（Phase5 ad_target_monitors 由来）、それ以外はクラス継承（view 由来）。
 */
export type EffectiveAdForMonitor = Omit<EffectiveAd, "classId">;

/** モニタ直指定広告の scope_rank（class=3 より後＝最も具体的）。クラス継承の後に並べる。 */
const MONITOR_SCOPE_RANK = 4;

/**
 * 指定クラスの実効広告 (自クラス広告 + 親階層から伝搬した広告) を階層順で返す。
 *
 * 並び順は `(scope_rank, display_order, ad_id)` で決定的:
 *   scope_rank = school(0) → department(1) → grade(2) → class(3) の広 → 狭。
 *   再生制御層 (#48-G useAdRotation 移植) が必要なら再ソートしてよい。
 *
 * テナント分離は VIEW の `security_invoker` により、呼び出し接続の RLS コンテキスト
 * (`app.current_school_id`) で DB レベルに強制される (CLAUDE.md ルール2)。呼び出し側
 * (middleware #48-B) が `SET LOCAL app.current_school_id` 済の接続/トランザクションで
 * 実行すること。`db` には RLS をバイパスしない接続ロール (kimiterrace_app) を使う。
 *
 * @param db      RLS コンテキスト設定済の Drizzle 接続 (またはトランザクション)
 * @param classId 対象クラス ID
 */
export async function getEffectiveAdsForClass(
  db: Pick<PostgresJsDatabase, "select">,
  classId: string,
): Promise<EffectiveAd[]> {
  return await db
    .select()
    .from(effectiveAdsPerClass)
    .where(eq(effectiveAdsPerClass.classId, classId))
    .orderBy(
      asc(effectiveAdsPerClass.scopeRank),
      asc(effectiveAdsPerClass.displayOrder),
      asc(effectiveAdsPerClass.adId),
    );
}

/**
 * 指定モニタ（端末）に表示する実効広告を返す。**クラス継承**（端末の所属クラスに伝搬した広告 =
 * `effective_ads_per_class`）と **モニタ直指定**（Phase5 `ad_target_monitors` で当該端末を直接対象にした
 * `scope='monitor'` 広告）を統合し、`(scope_rank, display_order, ad_id)` で決定的に並べて返す。
 *
 * - **追加モード（設計ロック）**: モニタ直指定はクラス配信を「置き換えず」**上乗せ**する。所属クラスを持つ
 *   端末はクラス広告 ∪ 自端末直指定、クラス無し端末（廊下等・`classId=null`）はモニタ直指定のみ。
 * - **重複排除不要**: 広告は scope を 1 つだけ持つ（`scope='monitor'` は ad_target_monitors 経由、それ以外は
 *   view 経由）。両集合は ad.id で素に分かれるため単純連結でよい。
 * - **並び順**: モニタ直指定は `scope_rank=4`（class=3 の後＝最も具体的）。`getEffectiveAdsForClass` と同規約。
 *
 * テナント分離は呼び出し接続の RLS コンテキスト（`app.current_school_id`）で DB レベルに強制される
 * （ルール2）: view は `security_invoker`、`ads` / `ad_target_monitors` は `tenant_isolation`。よって他校端末の
 * `monitorId` を渡しても他校の行は不可視（0 件）になり、越境配信は構造的に起きない。呼び出し側は非 BYPASSRLS
 * 接続（kimiterrace_app）で `SET LOCAL app.current_school_id` 済の tx で実行すること。
 *
 * @param db        RLS コンテキスト設定済の Drizzle 接続（またはトランザクション）
 * @param classId   端末の所属クラス ID。クラス無し端末（廊下等）は null（クラス継承は空集合になる）
 * @param monitorId 対象端末 ID（`tv_devices.id`）。`ad_target_monitors.monitor_id` で直指定広告を引く
 */
export async function getEffectiveAdsForMonitor(
  db: Pick<PostgresJsDatabase, "select">,
  classId: string | null,
  monitorId: string,
): Promise<EffectiveAdForMonitor[]> {
  // クラス継承: 所属クラスの実効広告（view 由来）。classId が無い端末は空集合（クエリ自体を省く）。
  const classAds: EffectiveAdForMonitor[] = classId
    ? await db
        .select({
          adId: effectiveAdsPerClass.adId,
          schoolId: effectiveAdsPerClass.schoolId,
          sourceScope: effectiveAdsPerClass.sourceScope,
          scopeRank: effectiveAdsPerClass.scopeRank,
          isInherited: effectiveAdsPerClass.isInherited,
          mediaUrl: effectiveAdsPerClass.mediaUrl,
          mediaType: effectiveAdsPerClass.mediaType,
          durationSec: effectiveAdsPerClass.durationSec,
          linkUrl: effectiveAdsPerClass.linkUrl,
          caption: effectiveAdsPerClass.caption,
          captionFontScale: effectiveAdsPerClass.captionFontScale,
          displayOrder: effectiveAdsPerClass.displayOrder,
        })
        .from(effectiveAdsPerClass)
        .where(eq(effectiveAdsPerClass.classId, classId))
    : [];

  // モニタ直指定: ad_target_monitors で当該端末を対象にした広告（scope='monitor'）。view を通さないため
  // ここで EffectiveAdForMonitor 形へ射影する（scope_rank=4 / is_inherited=false を付与）。
  // **休止広告主の除外（BUG-1 と同方針）**: クラス継承は view が `advertiser_is_deliverable` で paused を
  // 落とすが、モニタ直指定はその view を通らない。配信ロールからは advertisers が不可視（system_admin_only）
  // なので、同じ SECURITY DEFINER 関数で status だけを判定して整合させる（advertiser_id=NULL は配信対象）。
  const monitorRows = await db
    .select({
      adId: ads.id,
      schoolId: ads.schoolId,
      sourceScope: ads.scope,
      mediaUrl: ads.mediaUrl,
      mediaType: ads.mediaType,
      durationSec: ads.durationSec,
      linkUrl: ads.linkUrl,
      caption: ads.caption,
      captionFontScale: ads.captionFontScale,
      displayOrder: ads.displayOrder,
    })
    .from(adTargetMonitors)
    .innerJoin(ads, eq(ads.id, adTargetMonitors.adId))
    .where(
      and(
        eq(adTargetMonitors.monitorId, monitorId),
        sql`advertiser_is_deliverable(${ads.advertiserId})`,
      ),
    );
  const monitorAds: EffectiveAdForMonitor[] = monitorRows.map((r) => ({
    ...r,
    scopeRank: MONITOR_SCOPE_RANK,
    isInherited: false,
  }));

  // 連結して (scope_rank, display_order, ad_id) で決定的に並べる（getEffectiveAdsForClass と同規約）。
  return [...classAds, ...monitorAds].sort(
    (a, b) =>
      a.scopeRank - b.scopeRank || a.displayOrder - b.displayOrder || a.adId.localeCompare(b.adId),
  );
}
