import { sql } from "drizzle-orm";
import { foreignKey, index, pgTable, timestamp, unique, uuid, varchar } from "drizzle-orm/pg-core";
import { auditColumns } from "../_shared/audit.js";
import { classes } from "./classes.js";
import { schools } from "./schools.js";
import { users } from "./users.js";

/**
 * F05: クラス単位の magic link / 生徒匿名アクセス。
 *
 * 教員がクラスに 1 つの URL を発行し、生徒は個人ログインせず閲覧する。
 * `class_id` を持つ行が F05 のクラスリンク。`token` は **平文を保存せず hash**
 * (`token_hash`) のみ持つ。平文はログ・コード・DB に残さない (CLAUDE.md ルール5)。
 *
 * 生徒は school_id を未確定のまま `/s/{token}` に到達するため、token → school_id の
 * 解決は RLS をくぐれない。これは migration `0008` の SECURITY DEFINER 関数
 * `resolve_magic_link(token_hash)` という **唯一の細い扉** に閉じ込め、有効
 * (`revoked_at IS NULL` かつ未期限) な行のみを最小カラムで返す。解決後にアプリが
 * `SET LOCAL app.current_school_id` を張り、以降は通常 RLS 下で処理する。
 *
 * `user_id` は F05 では常に null (個人特定情報を持たない)。旧・保護者単回リンク用途の
 * 名残として残置。`consumed_at` も同様 (クラスリンクは再利用のため消費しない)。
 */
export const magicLinks = pgTable(
  "magic_links",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: uuid("school_id")
      .notNull()
      .references(() => schools.id, { onDelete: "restrict" }),
    /**
     * F05 クラスリンクの対象クラス。クラス削除でリンクも失効させるため cascade。
     * FK は (class_id, school_id) の composite で張る (#204、下記 foreignKey 参照) —
     * 別テナントの class を指すクラスリンクの発行を DB で弾く (cross-tenant write 整合)。
     * nullable: 旧・保護者単回リンクは class_id NULL で、MATCH SIMPLE により FK 検査をスキップ。
     */
    classId: uuid("class_id"),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    tokenHash: varchar("token_hash", { length: 128 }).notNull(),
    /** デフォルト 90 日 (F05)。教員 UI から短縮/延長可能。 */
    expiresAt: timestamp("expires_at", { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '90 days'`),
    /** 失効時刻。非 null = 失効済 (生徒アクセスは 410 Gone)。漏洩検知時に即時設定。 */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    /**
     * 旧・保護者単回リンクの「消費済み」時刻。**F05 クラスリンクでは未使用** (クラスリンクは
     * 期限/失効まで多数の生徒が再利用するため消費の概念がなく、`resolve_magic_link` も参照しない)。
     * 旧用途の名残として残置。#147 L3 で「当面 keep」判断 — 列削除はデータ消失を伴うため
     * 移行完了後の別 migration 候補に留める。
     */
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => ({
    ixToken: index("ix_magic_links_token_hash").on(t.tokenHash),
    ixSchool: index("ix_magic_links_school_id").on(t.schoolId),
    ixClass: index("ix_magic_links_class_id").on(t.classId),
    // 子側 (ai_chat_sessions.(magic_link_id, school_id)) から composite FK で参照される (#73)。
    uqIdSchool: unique("uq_magic_links_id_school").on(t.id, t.schoolId),
    // cross-tenant write 整合 (#204): class と school_id の一致を composite FK で強制。
    // classes には uq_classes_id_school (#203) があるため参照先 UNIQUE は既存。
    fkClass: foreignKey({
      columns: [t.classId, t.schoolId],
      foreignColumns: [classes.id, classes.schoolId],
      name: "fk_magic_links_class",
    }).onDelete("cascade"),
  }),
);
