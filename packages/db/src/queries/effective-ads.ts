import { asc, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { effectiveAdsPerClass } from "../schema/effective-ads-view.js";

/** `effective_ads_per_class` VIEW の 1 行 (= あるクラスの実効広告 1 件)。 */
export type EffectiveAd = typeof effectiveAdsPerClass.$inferSelect;

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
