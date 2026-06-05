import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { auditColumns } from "../_shared/audit.js";
import { eventType } from "../_shared/enums.js";
import { contents } from "./contents.js";
import { schools } from "./schools.js";
import { users } from "./users.js";

/** F07: 行動ログ（view/tap/dwell/ask）。 */
export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: uuid("school_id")
      .notNull()
      .references(() => schools.id, { onDelete: "restrict" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    contentId: uuid("content_id").references(() => contents.id, { onDelete: "set null" }),
    type: eventType("type").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().default(sql`now()`),
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
    ...auditColumns,
  },
  (t) => ({
    ixSchoolTime: index("ix_events_school_time").on(t.schoolId, t.occurredAt),
    // F13 presence の冪等 dedup を **DB レベルで直列化**する部分 UNIQUE index（#567）。
    // SwitchBot webhook の同一再送（同 device_mac + 同 occurred_at）を `recordPresenceEvent` は
    // app 層の SELECT→INSERT で弾くが、それは行ロックでも UNIQUE でもないため、**並行再送（TOCTOU）**で
    // 両 tx が SELECT で 0 行を観測 → 両方 INSERT する phantom race が起きうる（READ COMMITTED）。
    // 本 index を直列化の真の砦にし、`recordPresenceEvent` の INSERT は ON CONFLICT DO NOTHING で原子化する。
    // device_mac はグローバル UNIQUE（ux_sensor_devices_device_mac）ゆえ (device_mac, occurred_at) は
    // 1 校に解決されるが、テナント整合のため school_id も鍵に含める。type='presence' に限定した部分 index
    // なので view/tap/dwell/ask の通常イベントには制約を課さない（payload に device_mac を持たない）。
    // null-ts（#437 で受信時刻 now() に倒される検知）は occurred_at が毎回異なり本 index では衝突しない
    // ＝ #437 の「検知を捨てず受信時刻で記録・行数膨張は IP レート制限が律速」設計を保つ（dedup 対象外）。
    uxPresenceDedup: uniqueIndex("ux_events_presence_dedup")
      .on(t.schoolId, sql`(${t.payload} ->> 'device_mac')`, t.occurredAt)
      .where(sql`${t.type} = 'presence'`),
  }),
);
