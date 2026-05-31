import { sql } from "drizzle-orm";
import { foreignKey, index, integer, pgTable, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { auditColumns } from "../_shared/audit.js";
import { classes } from "./classes.js";
import { magicLinks } from "./magic-links.js";
import { schools } from "./schools.js";

/**
 * F06: 生徒対話セッション（端末/クラス magic_link に紐付く RAG 質疑応答セッション）。
 *
 * 同一 magic_link（≒同一クラス端末）からの連続質問をひとまとめにし、`message_count` /
 * `rate_limit_*` で 1 分あたりの呼び出しレートを制御する（暴走・課金事故防止）。
 * セッション終了は `closed_at` を立てる（タイムアウト or 明示的クローズ）。
 *
 * 関連: F06 (docs/requirements/functional/F06-student-qa.md), ADR-019 (RLS)
 */
export const aiChatSessions = pgTable(
  "ai_chat_sessions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: uuid("school_id")
      .notNull()
      .references(() => schools.id, { onDelete: "restrict" }),
    // 端末認証経路（生徒は magic_link でクラス端末にバインド）。
    // FK は (magic_link_id, school_id) の composite で張る (#73、下記 foreignKey 参照) —
    // 単純 FK だと magic_link が別テナントを指してもテナント混在を DB が許してしまうため。
    magicLinkId: uuid("magic_link_id").notNull(),
    // 検索性向上のため denormalize（class 単位での集計クエリで毎回 join しない）。
    // こちらも (class_id, school_id) の composite FK で張る (#73)。
    classId: uuid("class_id").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().default(sql`now()`),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    messageCount: integer("message_count").notNull().default(0),
    // レート制限（1 分 / 端末あたり）の集計窓
    rateLimitWindowStart: timestamp("rate_limit_window_start", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    rateLimitCount: integer("rate_limit_count").notNull().default(0),
    // セッション終了（タイムアウト or 明示的クローズ）。null = active
    closedAt: timestamp("closed_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => ({
    ixSchool: index("ix_ai_chat_sessions_school_id").on(t.schoolId),
    ixMagicLink: index("ix_ai_chat_sessions_magic_link_id").on(t.magicLinkId),
    ixLastMessage: index("ix_ai_chat_sessions_last_message_at").on(t.lastMessageAt),
    // 子側から composite FK で参照される (ai_chat_messages.(session_id, school_id))。
    uqIdSchool: unique("uq_ai_chat_sessions_id_school").on(t.id, t.schoolId),
    // cross-tenant write 整合を DB 強制 (#73、PR #71 H-1)。RLS は read を守るが write の
    // テナント混在は守らないため、(fk列, school_id) の composite FK で親と school_id 一致を強制。
    fkMagicLink: foreignKey({
      columns: [t.magicLinkId, t.schoolId],
      foreignColumns: [magicLinks.id, magicLinks.schoolId],
      name: "fk_ai_chat_sessions_magic_link",
    }).onDelete("cascade"),
    fkClass: foreignKey({
      columns: [t.classId, t.schoolId],
      foreignColumns: [classes.id, classes.schoolId],
      name: "fk_ai_chat_sessions_class",
    }).onDelete("restrict"),
  }),
);
