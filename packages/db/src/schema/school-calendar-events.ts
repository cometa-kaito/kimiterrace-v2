import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { auditColumns } from "../_shared/audit.js";
import { schoolCalendarSources } from "./school-calendar-sources.js";
import { schools } from "./schools.js";

/**
 * ADR-045: 学校行事カレンダーの **イベントキャッシュ**（per-school・テナント分離）。
 *
 * ## 役割 — 公開 iCal から取り込んだ行事の表示用キャッシュ
 * 既存の天気 Cloud Run Job が per-school フェーズで `school_calendar_sources.icsUrl`（公開 iCal/ICS）を取得 →
 * VEVENT をパース → 本テーブルへ **upsert** する。サイネージ端末・Server Component は **自社 DB から SELECT する
 * だけ**で iCal URL を直叩きしない（閉域維持・端末は外部に出ない、ADR-044 / [[closed-system-security]] と同思想）。
 * 表示は `startDate`（JST 暦日）でレンジ取得する想定（盤面の「今週の行事」等）。盤面結線は follow-up（別 PR）。
 *
 * ## ★ テナント分離（ルール2 / ADR-019）
 * `school_id` を持つテナント分離テーブル。RLS は migrations/00NN_school_calendar_rls.sql で **tenant_isolation**
 * （school_id 一致）+ **system_admin_full_access**（取得 Job）を付与する。**匿名サイネージ**（role 未設定・
 * school_id のみ set）が自校の行事を読めること、**他校が読めない**ことを RLS テストで固定する。取得 Job は
 * system_admin context で各校の school_id を明示して cross-tenant に upsert する（system_admin_full_access 経由・
 * BYPASSRLS 不使用）。weather_warnings（公開・非 PII・read_all）とは異なり、行事は **学校固有データ**なので
 * tenant_isolation で他校から不可視にする（これが本 PR の肝）。
 *
 * ## 一意性 / upsert
 * `(school_id, uid)` で一意。`uid` は iCal の VEVENT UID（無ければ取得 Job がソース安定キーから生成）。再取得は
 * 競合キーでの UPDATE（last-known-good 更新）。iCal から消えた行事の掃除は `deleteStaleCalendarEvents`
 * （**同期中の source_id スコープ内**で keepUids に無いものを削除。ADR-049 決定 2）で行う。
 *
 * ## ファイル取込由来イベント（ADR-049、migration 不要）
 * 年間行事ファイル取込（AI 構造化）由来の行事は `source_id = null`・`uid = 'file:<batchId>:<n>'` の名前空間で
 * 本テーブルに同居する。境界は `source_id IS NULL AND uid LIKE 'file:%'` の二重条件（書き込み口は
 * `replaceFileImportedEvents` に単一化・iCal 側は `sanitizeIcalEventUid` がリライトで侵食を防ぐ）。
 *
 * ## ★ PII 非格納 / サイネージ露出（ルール4 / ADR-045）
 * 接続するのは「学校公開行事カレンダー」専用の運用前提（school_calendar_sources のコメント参照）。`summary` /
 * `location` には公開行事名・場所のみが入る想定で、生徒氏名等の PII を含む私的カレンダーを繋がない。本テーブルは
 * tenant_isolation で他校から不可視。LLM / embedding 経路には載せない（ルール4）。
 *
 * ## 監査（ルール1）
 * `auditColumns` を付与。取得 Job の書き込みは created_by/updated_by = null（システム = `system://calendar-fetch`、
 * auditColumns の「システム作成は null」規約）。created_by/updated_by → users(id) の FK は循環依存回避のため
 * migration で後付けする（0016 / 0017 と同じパターン）。
 *
 * 関連: ADR-045, ADR-044, ADR-019, ADR-016（サイネージ匿名）。
 * 非スコープ（follow-up）: サイネージ盤面への行事表示の結線（apps/web、別 PR）。RRULE 展開の本格対応（取得 Job の
 *   パーサが対応するサブセットは ADR-045 に明記）。
 */
export const schoolCalendarEvents = pgTable(
  "school_calendar_events",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // テナント分離キー。学校削除時は restrict（行事行を残したまま親を消させない＝tv_devices / sources と同方針）。
    schoolId: uuid("school_id")
      .notNull()
      .references(() => schools.id, { onDelete: "restrict" }),
    // iCal VEVENT UID（無ければ取得 Job がソース安定キー = 例: ハッシュ から生成）。(school_id, uid) で一意。
    uid: varchar("uid", { length: 512 }).notNull(),
    // 行事名（iCal SUMMARY）。公開行事名のみ（PII 非格納の運用前提）。長文化しうるため text。
    summary: text("summary"),
    // 開始日（JST 暦日）。レンジ取得の主キー次元（盤面の「今週の行事」等）。終日/時刻付き両方でセットする。
    startDate: date("start_date", { mode: "string" }).notNull(),
    // 終了日（JST 暦日、複数日行事）。単日なら null。
    endDate: date("end_date", { mode: "string" }),
    // 時刻付き行事の開始/終了（DTSTART/DTEND に時刻があるとき）。終日行事は null（allDay=true）。
    startAt: timestamp("start_at", { withTimezone: true, mode: "date" }),
    endAt: timestamp("end_at", { withTimezone: true, mode: "date" }),
    // 終日行事か（iCal DTSTART;VALUE=DATE）。既定 false。
    allDay: boolean("all_day").notNull().default(false),
    // 場所（iCal LOCATION）。公開行事の場所のみ（PII 非格納の運用前提）。
    location: varchar("location", { length: 512 }),
    // どのソース設定由来か（運用追跡）。ソース行削除時は SET NULL（行事は残す）。
    sourceId: uuid("source_id").references(() => schoolCalendarSources.id, {
      onDelete: "set null",
    }),
    // 原文（VEVENT のパース済みフィールド等）の保全。iCal は実装差があるため後追い解析用に残す。
    raw: jsonb("raw").notNull().default(sql`'{}'::jsonb`),
    ...auditColumns,
  },
  (t) => ({
    // 同一校・同一 UID は 1 行（再取得は upsert / ON CONFLICT 競合キー）。
    uxSchoolUid: unique("ux_school_calendar_events_school_uid").on(t.schoolId, t.uid),
    // school × 日付レンジ取得（盤面の「今週の行事」等）。
    ixSchoolStart: index("ix_school_calendar_events_school_start").on(t.schoolId, t.startDate),
  }),
);
