import { boolean, integer, pgView, real, text, uuid, varchar } from "drizzle-orm/pg-core";
import { adMediaType, hierarchyScope } from "../_shared/enums.js";

/**
 * 広告階層マージ VIEW `effective_ads_per_class` の型定義 (#48-F)。
 *
 * 実体は手書き SQL (`migrations/0011_effective_ads_view.sql`) で
 * `security_invoker = true` 付き通常 VIEW として作成する。drizzle-kit には
 * `.existing()` で「既存・管理対象外」と伝え、CREATE VIEW を生成させない
 * (列型だけを単一ソースとして共有し、型安全な SELECT を可能にする / CLAUDE.md ルール3)。
 *
 * 各行 = 「あるクラスで表示すべき実効広告 1 件」。自クラス広告に加え、親階層
 * (学校 / 学科 / 学年) から伝搬した広告も含む。`is_inherited=true` は親階層由来で
 * 子クラスでは編集不可 (V1 の「親階層広告は編集不可」挙動)。
 */
export const effectiveAdsPerClass = pgView("effective_ads_per_class", {
  classId: uuid("class_id").notNull(),
  adId: uuid("ad_id").notNull(),
  schoolId: uuid("school_id").notNull(),
  // 広告が定義された階層 (school / department / grade / class)
  sourceScope: hierarchyScope("source_scope").notNull(),
  // ソート用ランク: school=0 / department=1 / grade=2 / class=3
  scopeRank: integer("scope_rank").notNull(),
  // 親階層から伝搬したか (= source_scope <> 'class') → UI で編集不可フラグに使う
  isInherited: boolean("is_inherited").notNull(),
  mediaUrl: text("media_url").notNull(),
  mediaType: adMediaType("media_type").notNull(),
  durationSec: integer("duration_sec").notNull(),
  linkUrl: text("link_url"),
  caption: varchar("caption", { length: 60 }),
  captionFontScale: real("caption_font_scale").notNull(),
  displayOrder: integer("display_order").notNull(),
}).existing();
