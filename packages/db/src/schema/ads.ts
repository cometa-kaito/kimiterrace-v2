import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  real,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { auditColumns } from "../_shared/audit.js";
import { adMediaType, hierarchyScope } from "../_shared/enums.js";
import { advertisers } from "./advertisers.js";
import { classes } from "./classes.js";
import { departments } from "./departments.js";
import { grades } from "./grades.js";
import { schools } from "./schools.js";

/**
 * サイネージ広告。V1 `displaySettings.ads[]`（学校/学科/学年/クラス各階層）の正規化。
 *
 * - V1 では配列要素だったものを 1 行/広告に展開し、`display_order` を明示列化
 * - `scope` + 各 *_id で階層を表現。学校→学年→クラス（→学科）のマージは #48-F の View で実施
 * - `advertiser_id`（任意）で **CRM の広告主アカウント**に紐付ける (#46 運営側広告 CRM)。運営
 *   (system_admin) が広告主のために入稿した広告に設定し、学校 (school_admin) が自校で作るクラス広告は
 *   null。FK は `set null`（広告主削除でも広告自体は残し紐付けのみ解除）。
 */
export const ads = pgTable(
  "ads",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: uuid("school_id")
      .notNull()
      .references(() => schools.id, { onDelete: "restrict" }),
    scope: hierarchyScope("scope").notNull(),
    gradeId: uuid("grade_id").references(() => grades.id, { onDelete: "cascade" }),
    departmentId: uuid("department_id").references(() => departments.id, { onDelete: "cascade" }),
    classId: uuid("class_id").references(() => classes.id, { onDelete: "cascade" }),
    // CRM 広告主への紐付け (#46)。運営入稿広告に設定、学校作成のクラス広告は null。広告主削除で null 化。
    advertiserId: uuid("advertiser_id").references(() => advertisers.id, { onDelete: "set null" }),
    mediaUrl: text("media_url").notNull(),
    mediaType: adMediaType("media_type").notNull(),
    // 画像の表示秒数（動画は再生完了で次へ）。V1 デフォルト 5 秒。
    durationSec: integer("duration_sec").notNull().default(5),
    linkUrl: text("link_url"),
    caption: varchar("caption", { length: 60 }),
    // 文字サイズ倍率（V1: 0.85 / 1.0 / 1.3 / 1.6）。
    captionFontScale: real("caption_font_scale").notNull().default(1),
    displayOrder: integer("display_order").notNull().default(0),
    // Partner API K3（partner-api-contract §3）の冪等キー。portal 側 placement の UUID を保持し、
    // POST /api/partner/delivery が (portal_placement_id, school_id) を競合キーに upsert する。
    // portal 由来 ID の外部参照（v2 テーブルへの FK ではない）。学校作成のクラス広告など
    // portal 非経由の行は null。nullable + unique（NULL は複数行可）。
    //
    // ⚠ 一意性は **school_id との複合**（20260724_multi_school_ads）。portal の複数校ループ
    //   （1申込＝N校同時配信）は 1 placement から **校ごとに1広告行**を生むため、単独 unique だと
    //   ON CONFLICT DO UPDATE が順に上書きし、エラーも出さずに最後の1校だけが残る（黙って1校配信）。
    portalPlacementId: uuid("portal_placement_id"),
    ...auditColumns,
  },
  (t) => ({
    ixTargetOrder: index("ix_ads_target_order").on(t.schoolId, t.scope, t.displayOrder),
    // 1 placement × 1 学校 = 1 広告行（複数校ループの同時配信を成立させる複合キー）。
    uxPortalPlacementSchool: uniqueIndex("ux_ads_portal_placement_school").on(
      t.portalPlacementId,
      t.schoolId,
    ),
    ckScope: check(
      "ck_ads_scope",
      sql`(
        (${t.scope} = 'school' AND ${t.gradeId} IS NULL AND ${t.classId} IS NULL AND ${t.departmentId} IS NULL)
        OR (${t.scope} = 'grade' AND ${t.gradeId} IS NOT NULL AND ${t.classId} IS NULL)
        OR (${t.scope} = 'department' AND ${t.departmentId} IS NOT NULL AND ${t.gradeId} IS NULL AND ${t.classId} IS NULL)
        OR (${t.scope} = 'class' AND ${t.classId} IS NOT NULL)
        OR (${t.scope} = 'monitor' AND ${t.gradeId} IS NULL AND ${t.classId} IS NULL AND ${t.departmentId} IS NULL)
      )`,
    ),
    ckDuration: check("ck_ads_duration_positive", sql`${t.durationSec} > 0`),
  }),
);
