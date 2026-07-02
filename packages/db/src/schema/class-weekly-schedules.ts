import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, unique, uuid } from "drizzle-orm/pg-core";
import { auditColumns } from "../_shared/audit.js";
import { classes } from "./classes.js";
import { schools } from "./schools.js";

/**
 * 週次ベース時間割（F5・editor-input-tiers-and-signage-paging.md §7）。クラスの**基本時間割**（月〜金の各コマの
 * 科目）を **1 クラス 1 行**で保持する。
 *
 * ## 狙い・反映方式（コピーオンライト）
 * 教員が基本時間割を 1 回登録すると、日々のエディタは対象日の `daily_data.schedules` が**空のとき**だけ、その曜日の
 * 基本時間割を**初期値に seed** する（教員は確認＋差分編集して保存＝`daily_data` へ materialize）。**盤面の表示時
 * マージはしない**（signage の表示経路は無改修・設計書 §3 F5 / §6.5）。学期・時間割変更は本テンプレの上書きで表現し、
 * コピーオンライトなので既に materialize 済みの過去日は不変（未編集の未来日だけ新テンプレで初期化）。
 *
 * ## 保存形（JSONB・daily_data と一貫）
 * `schedule_by_weekday` は `{"1":[ScheduleItem...], "2":[...], … "5":[...]}`（キー=曜日 1=月..5=金・値=既存
 * `ScheduleItem` 配列）。daily_data.schedules と同じ JSONB 流儀にして、検証（`validateScheduleItems`）と
 * エディタ部品を流用できるようにする。空の曜日はキーごと省略（既定 `{}`）。
 *
 * ## テナント分離（ルール2 / ADR-019）
 * `school_id` を持つテナント分離テーブル。RLS は `migrations/0036_class_weekly_schedules_rls.sql` で
 * tenant_isolation（school_id 一致）+ system_admin_full_access を付与（class_visitors / daily_data と同パターン）。
 * 編集（school_admin / teacher）は RLS が自校に限定し、手書き WHERE school_id には依存しない。
 *
 * ## 監査（ルール1）
 * `auditColumns` を付与。created_by/updated_by → users(id) の FK は循環依存回避のため migration で後付けする。
 */
export const classWeeklySchedules = pgTable(
  "class_weekly_schedules",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // テナント分離キー。学校削除時は restrict（テンプレ行を残したまま親を消させない）。
    schoolId: uuid("school_id")
      .notNull()
      .references(() => schools.id, { onDelete: "restrict" }),
    // 対象クラス。クラス削除でテンプレも削除（cascade。基本時間割はそのクラス固有で残す意味が無い）。
    classId: uuid("class_id")
      .notNull()
      .references(() => classes.id, { onDelete: "cascade" }),
    // 曜日(1=月..5=金)別の基本時間割。{"1":[ScheduleItem...],...}。既定 '{}'（未登録）。
    scheduleByWeekday: jsonb("schedule_by_weekday").notNull().default(sql`'{}'::jsonb`),
    ...auditColumns,
  },
  (t) => ({
    // 1 クラス 1 行（基本時間割はクラスにつき単一）。upsert の衝突キー。
    uxClass: unique("ux_class_weekly_schedules_class").on(t.classId),
    // school 別の運用一覧・ヘルス用。
    ixSchool: index("ix_class_weekly_schedules_school").on(t.schoolId),
  }),
);
