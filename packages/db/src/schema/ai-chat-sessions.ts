import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns } from "../_shared/audit.js";
import { classes } from "./classes.js";
import { magicLinks } from "./magic-links.js";
import { schools } from "./schools.js";
import { users } from "./users.js";

/**
 * F06: AI 対話セッション（RAG 質疑応答の連続質問のまとまり）。
 *
 * **2 つの認証経路を 1 テーブルで表す（#370 / ADR-028）**:
 *  - **生徒（匿名）**: クラス magic_link に紐付く。`magic_link_id` + `class_id` を持ち `user_id` は null。
 *  - **教員（認証済）**: Identity Platform セッションに紐付く。`user_id` を持ち `magic_link_id` /
 *    `class_id` は null（教員はクラス端末にバインドされない、レート制限キーは user_id）。
 *
 * 同一経路からの連続質問をひとまとめにし、`message_count` / `rate_limit_*` で 1 分あたりの呼び出し
 * レートを制御する（暴走・課金事故防止）。セッション終了は `closed_at` を立てる（タイムアウト or
 * 明示的クローズ）。
 *
 * ## 認証経路の排他性（`ck_ai_chat_sessions_identity`、整合の DB 強制）
 * `magic_link_id` と `user_id` の **ちょうど一方**が非 null であることを XOR CHECK で強制する。
 * これにより (a) 生徒行が誤って `magic_link_id` を欠く（両方 null）バグ、(b) 1 セッションが匿名と
 * 認証の両方を主張する不整合、をいずれも DB レベルで弾く（ルール1 の追跡性 + テナント健全性）。
 * 既存の生徒行は `magic_link_id` 非 null・`user_id` null のため XOR を満たす（データ移行不要）。
 *
 * 関連: F06 (docs/requirements/functional/F06-student-qa.md), ADR-019 (RLS), ADR-028 (回答ポリシー / 教員経路)
 */
export const aiChatSessions = pgTable(
  "ai_chat_sessions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: uuid("school_id")
      .notNull()
      .references(() => schools.id, { onDelete: "restrict" }),
    // 端末認証経路（生徒は magic_link でクラス端末にバインド）。**生徒経路のみ非 null**（教員経路は
    // null、XOR CHECK で user_id と排他）。FK は (magic_link_id, school_id) の composite で張る (#73、
    // 下記 foreignKey 参照) — 単純 FK だと magic_link が別テナントを指してもテナント混在を DB が許して
    // しまうため。nullable のため MATCH SIMPLE で magic_link_id が null の教員行は FK 検査を素通りする。
    magicLinkId: uuid("magic_link_id"),
    // 認証経路（教員は Identity Platform セッション）。**教員経路のみ非 null**（生徒経路は null、XOR
    // CHECK で magic_link_id と排他）。created_by (auditColumns) と同じく users.id への単純 FK とし、
    // テナント整合は user の school_id = セッションの school_id (RLS 文脈で確立) + RLS に委ねる。
    userId: uuid("user_id").references(() => users.id, { onDelete: "restrict" }),
    // 検索性向上のため denormalize（class 単位での集計クエリで毎回 join しない）。**生徒経路のみ非 null**
    // （教員はクラス端末にバインドされないため null）。こちらも (class_id, school_id) の composite FK で
    // 張る (#73)。nullable のため class_id が null の教員行は MATCH SIMPLE で FK 検査を素通りする。
    classId: uuid("class_id"),
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
    ixMagicLink: index("ix_ai_chat_sessions_magic_link_id").on(t.magicLinkId),
    ixLastMessage: index("ix_ai_chat_sessions_last_message_at").on(t.lastMessageAt),
    // 教員経路 (#370) のセッション検索 `WHERE school_id=? AND user_id=? AND closed_at IS NULL` を賄う。
    // ADR-019 に合わせ school_id 先頭の複合。user_id は教員行のみ非 null（生徒行は索引に NULL で載る）。
    ixSchoolUser: index("ix_ai_chat_sessions_school_user").on(t.schoolId, t.userId),
    // ADR-019: RLS テーブルは school_id を先頭に持つ複合インデックスを基本とする（PR #71 Reviewer M-3）。
    // school 内「最近のセッション順」(ORDER BY last_message_at DESC) を 1 本で賄う。bare (school_id)
    // インデックスは school_id 先頭の本複合に内包されるため旧 ix_ai_chat_sessions_school_id は廃止。
    // 方向は既定(ASC)。btree は後方スキャンで DESC ORDER BY も同コストで賄うため明示 DESC は不要。
    ixSchoolLastMessage: index("ix_ai_chat_sessions_school_last_message").on(
      t.schoolId,
      t.lastMessageAt,
    ),
    // denormalize した class_id を活かす class 単位集計の索引（M-4）。RLS 下のクエリは
    // school_id = ? AND class_id = ? の形になるため、ADR-019 に合わせ school_id 先頭の複合にする。
    ixSchoolClass: index("ix_ai_chat_sessions_school_class").on(t.schoolId, t.classId),
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
    // 認証経路の排他性 (#370): magic_link_id（生徒）と user_id（教員）の **ちょうど一方** が非 null。
    // boolean の `<>`(XOR) で「両方 null（経路欠落）」「両方非 null（経路二重）」をいずれも DB が弾く。
    ckIdentity: check(
      "ck_ai_chat_sessions_identity",
      sql`(${t.magicLinkId} IS NOT NULL) <> (${t.userId} IS NOT NULL)`,
    ),
  }),
);
