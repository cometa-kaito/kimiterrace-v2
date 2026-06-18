import { sql } from "drizzle-orm";
import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { auditColumns } from "../_shared/audit.js";
import { schools } from "./schools.js";

/**
 * ADR-045: 学校行事カレンダーの **公開 iCal/ICS ソース**設定（per-school・テナント分離）。
 *
 * ## 役割 — keyless 取込の「どの URL を読むか」設定
 * 学校ごとに 1 件の **公開 iCal/ICS URL**（Google カレンダーの「公開アドレス（iCal 形式）」等、認証不要で誰でも
 * GET できる URL）を保持する。既存の天気 Cloud Run Job（`apps/jobs/src/weather/`）が **per-school フェーズ**で
 * 本テーブルを列挙し、各校の `icsUrl` を取得 → 行事を `school_calendar_events` に upsert する。**新しい Cloud Run
 * Job / Cloud Scheduler は作らない**（ADR-045 §決定: ADR-044 の per-school 拡張・新規固定費ゼロ）。
 *
 * ## ★ なぜ keyless（公開 iCal）か（ルール5）
 * Google Calendar API でプライベートカレンダーを読むには **サービスアカウント JSON 鍵 / OAuth credentials** が
 * 必要だが、CLAUDE.md ルール5 は **service account JSON キーをファイルで配布することを禁じる**。よって本機能は
 * **認証不要の公開 iCal URL のみ**を扱う（Workload Identity で読める Google Calendar API 連携は別途要 ADR として
 * 見送り、ADR-045 §候補）。`icsUrl` には推測しにくい公開アドレスが入りうるが、それ自体は学校の公開行事カレンダーの
 * 在りかであって生徒・保護者の PII ではない（ルール4）。
 *
 * ## ★ テナント分離（ルール2 / ADR-019）
 * `school_id` を持つテナント分離テーブル。RLS は migrations/00NN_school_calendar_rls.sql で **tenant_isolation**
 * （school_id 一致）+ **system_admin_full_access**（取得 Job / 管理用）を付与する（tv_devices 0016 / daily_data と
 * 同型）。取得 Job は session が無いため、`tv_devices` のポーリング解決と同じく **system_admin context** で
 * cross-tenant に列挙・更新する（BYPASSRLS 不使用、system_admin_full_access 経由）。
 *
 * ## ★ PII 非格納 / サイネージ露出（ルール4 / ADR-045）
 * 接続するカレンダーは **「学校公開行事カレンダー」専用**（始業式・体育祭・定期試験等の公開行事）とし、生徒氏名・
 * 保護者名等を含む私的カレンダーを繋がない**運用前提**。`lastError` には取得失敗の最終理由（HTTP status・パース
 * エラー種別等）のみを入れ、**生 PII を入れない**。本テーブルおよび行事は LLM / embedding 経路に載せない（ルール4）。
 *
 * ## 監査（ルール1）
 * `auditColumns` を付与。created_by/updated_by → users(id) の FK は循環依存回避のため migration で後付けする
 * （_shared/audit.ts と 0016（TV）/ 0017（天気）と同じパターン）。設定編集 UI（school_admin が icsUrl 登録）は
 * follow-up（別 PR）。
 *
 * 関連: ADR-045（学校行事 iCal 取込）, ADR-044（keyless 外部データの天気 Job 相乗り・本 ADR の per-school 拡張元）,
 *   ADR-019（RLS 二層）, ルール5（keyless）。
 * 非スコープ（follow-up）: 設定 UI / サイネージ盤面への行事表示の結線（apps/web、別 PR）。複数ソース対応
 *   （現状は unique(school_id) で 1 校 1 ソース）。
 */
export const schoolCalendarSources = pgTable(
  "school_calendar_sources",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // テナント分離キー。学校削除時は restrict（設定行を残したまま親を消させない＝tv_devices と同方針）。
    schoolId: uuid("school_id")
      .notNull()
      .references(() => schools.id, { onDelete: "restrict" }),
    // 公開 iCal/ICS URL（認証不要で GET できる「公開アドレス（iCal 形式）」）。長さ可変ゆえ text。
    icsUrl: text("ics_url").notNull(),
    // 取得 Job の対象とするか。false なら取得をスキップ（メンテ中・一時停止）。既定 true。
    enabled: boolean("enabled").notNull().default(true),
    // 取得 Job が最後にこのソースを取得した時刻。鮮度・運用可視化。NULL = 未だ一度も取得していない。
    lastFetchedAt: timestamp("last_fetched_at", { withTimezone: true, mode: "date" }),
    // 取得失敗の最終理由（HTTP status・パースエラー種別等。運用可視化）。★ 生 PII を入れない（ルール4）。
    // 成功時は null にリセットする。
    lastError: text("last_error"),
    ...auditColumns,
  },
  (t) => ({
    // 1 校 1 ソース（複数ソース対応は follow-up）。テナント越境はしない（school_id は自校）。
    uxSchool: uniqueIndex("ux_school_calendar_sources_school").on(t.schoolId),
    // enabled な対象の列挙（取得 Job の per-school フェーズが走査）。
    ixEnabled: index("ix_school_calendar_sources_enabled").on(t.enabled),
  }),
);
