import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, real, text, uuid, varchar } from "drizzle-orm/pg-core";
import { auditColumns } from "../_shared/audit.js";
import { adMediaType, hierarchyScope } from "../_shared/enums.js";
import { classes } from "./classes.js";
import { departments } from "./departments.js";
import { grades } from "./grades.js";
import { schools } from "./schools.js";

/**
 * サイネージ広告。V1 `displaySettings.ads[]`（学校/学科/学年/クラス各階層）の正規化。
 *
 * - V1 では配列要素だったものを 1 行/広告に展開し、`display_order` を明示列化
 * - `scope` + 各 *_id で階層を表現。学校→学年→クラス（→学科）のマージは #48-F の View で実施
 * - 広告は CRM の `advertisers`（広告主アカウント）とは別概念（こちらは表示メディア）
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
    mediaUrl: text("media_url").notNull(),
    mediaType: adMediaType("media_type").notNull(),
    // 画像の表示秒数（動画は再生完了で次へ）。V1 デフォルト 5 秒。
    durationSec: integer("duration_sec").notNull().default(5),
    linkUrl: text("link_url"),
    caption: varchar("caption", { length: 60 }),
    // 文字サイズ倍率（V1: 0.85 / 1.0 / 1.3 / 1.6）。
    captionFontScale: real("caption_font_scale").notNull().default(1),
    displayOrder: integer("display_order").notNull().default(0),
    ...auditColumns,
  },
  (t) => ({
    ixTargetOrder: index("ix_ads_target_order").on(t.schoolId, t.scope, t.displayOrder),
    ckScope: check(
      "ck_ads_scope",
      sql`(
        (${t.scope} = 'school' AND ${t.gradeId} IS NULL AND ${t.classId} IS NULL AND ${t.departmentId} IS NULL)
        OR (${t.scope} = 'grade' AND ${t.gradeId} IS NOT NULL AND ${t.classId} IS NULL)
        OR (${t.scope} = 'department' AND ${t.departmentId} IS NOT NULL AND ${t.gradeId} IS NULL AND ${t.classId} IS NULL)
        OR (${t.scope} = 'class' AND ${t.classId} IS NOT NULL)
      )`,
    ),
    ckDuration: check("ck_ads_duration_positive", sql`${t.durationSec} > 0`),
  }),
);
