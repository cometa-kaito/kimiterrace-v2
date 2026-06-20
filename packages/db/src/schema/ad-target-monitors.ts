import { sql } from "drizzle-orm";
import { index, pgTable, unique, uuid } from "drizzle-orm/pg-core";
import { auditColumns } from "../_shared/audit.js";
import { ads } from "./ads.js";
import { schools } from "./schools.js";
import { tvDevices } from "./tv-devices.js";

/**
 * Phase5（運営整理 G）: 広告 ⇄ 個別モニタの直指定（M:N 中間表）。
 *
 * `ads.scope = 'monitor'` の広告が**どの tv_devices（モニタ）に配信されるか**を保持する。1 広告が複数モニタを
 * 指定でき（portal の多選択）、1 モニタが複数の monitor 広告に含まれうる（M:N）。`scope='monitor'` の広告は
 * 既存の `effective_ads_per_class` ビューに一致しない（クラス継承で配信されない）ため、モニタ単位の配信読取は
 * 別途（PR2: effective_ads_per_monitor 相当）で本表を辿って解決する。
 *
 * ## テナント分離 / RLS（ルール2 / ADR-019）
 * **`ads` と同じ二層 RLS**（migration 側で付与）:
 *   - `tenant_isolation` (school_id = app.current_school_id) … 学校ロール（サイネージ配信読取）が自校分のみ可視。
 *   - `system_admin_full_access` … Partner API K3（applyPartnerDelivery を system_admin context で実行）が全校横断に書ける。
 * このため `school_id` を**保持**する（contract_contents の CRM 中間表とは違い、サイネージ側の tenant 読取が
 * 必要なので tenant_isolation を貼る）。`school_id` は `ad.school_id` = `monitor.school_id` と一致する想定で、
 * 整合（モニタが当該校に属すること）は applyPartnerDelivery が検証する（CHECK ではサブクエリ不可のため）。
 *
 * ## FK onDelete
 *   - `ad_id` → `ads.id` CASCADE: 広告削除（再配信での upsert 置換含む）で紐付けも消す。
 *   - `monitor_id` → `tv_devices.id` CASCADE: モニタ削除で紐付けも消す（配信先が消えたら関連も無効）。
 *   - `school_id` → `schools.id` restrict: テナント親は残す。
 *
 * 重複防止: `UNIQUE(ad_id, monitor_id)`（同一広告に同一モニタを二重指定しない）。
 * 監査（ルール1）: auditColumns。K3 由来の書き込みは system 由来のため created_by/updated_by は null。
 */
export const adTargetMonitors = pgTable(
  "ad_target_monitors",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    adId: uuid("ad_id")
      .notNull()
      .references(() => ads.id, { onDelete: "cascade" }),
    monitorId: uuid("monitor_id")
      .notNull()
      .references(() => tvDevices.id, { onDelete: "cascade" }),
    // テナント分離キー（= ad.school_id = monitor.school_id）。RLS tenant_isolation 用に保持。
    schoolId: uuid("school_id")
      .notNull()
      .references(() => schools.id, { onDelete: "restrict" }),
    ...auditColumns,
  },
  (t) => ({
    uqAdMonitor: unique("uq_ad_target_monitors_ad_monitor").on(t.adId, t.monitorId),
    ixAd: index("ix_ad_target_monitors_ad_id").on(t.adId),
    ixMonitor: index("ix_ad_target_monitors_monitor_id").on(t.monitorId),
    ixSchool: index("ix_ad_target_monitors_school_id").on(t.schoolId),
  }),
);
