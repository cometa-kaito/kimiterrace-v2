import { pgEnum } from "drizzle-orm/pg-core";

// 役割: テナント内ユーザーのロール（system_admin はテナント外、system_admins テーブルで管理）
export const userRole = pgEnum("user_role", ["school_admin", "teacher", "student", "guardian"]);

// コンテンツ発行スコープ（F01-F04）
export const publishScope = pgEnum("publish_scope", ["school", "class", "homeroom", "private"]);

/**
 * 発行スコープの型（単一ソース）。アプリ層 (apps/web) は `import type` でこれを引き込み、
 * `satisfies readonly PublishScope[]` で許可値配列が enum とズレないことをコンパイル時に強制する
 * (`client.ts` の `TenantRole` と同方針)。型のみなので Next バンドルに enum のランタイム値を引き込まない。
 */
export type PublishScope = (typeof publishScope.enumValues)[number];

// コンテンツ状態
export const contentStatus = pgEnum("content_status", ["draft", "published", "archived"]);

// 行動イベント種別（F07）。
// `presence` は F13（来場検知 SwitchBot Webhook、ADR-020）で追加。PIR センサーの
// 「動きの瞬間検知」を表す。`dwell`（滞在秒数。LiDAR/カメラ等の継続滞在計測用途）とは
// 区別する — PIR は滞在時間を測れないため presence は別値にする（F13 §「presence と dwell の区別」）。
// 既存 view/tap/dwell/ask は変更しない（末尾追加 = ALTER TYPE ADD VALUE、非破壊）。
export const eventType = pgEnum("event_type", ["view", "tap", "dwell", "ask", "presence"]);

// F13: 来場検知センサーのベンダー（ADR-020）。現状 SwitchBot のみ。将来ベンダー追加時は
// 末尾に値を足す（ADD VALUE）。`sensor_devices.vendor` の値域を DB レベルで固定する（ルール3）。
export const sensorVendor = pgEnum("sensor_vendor", ["switchbot"]);

// F13: 来場検知センサーの方式（ADR-020）。`presence_pir` = PIR 方式の人感センサー
// （カメラ非搭載・個人識別なし、ADR-020 透明性要件）。滞在秒数は計測しない。
export const sensorKind = pgEnum("sensor_kind", ["presence_pir"]);

// AI 抽出種別（F03）
export const aiExtractionKind = pgEnum("ai_extraction_kind", [
  "schedule",
  "announcement",
  "summary",
  "tag",
]);

// AI 抽出の実行結果ステータス（F03）。varchar から enum 化し、想定外文字列の混入を DB で弾く
// （ルール3: 値域の単一ソース化。PR #71 Reviewer M-1）。
//   success … 抽出成功
//   retry   … 一時失敗でリトライ対象
//   failed  … 恒久失敗
export const aiExtractionStatus = pgEnum("ai_extraction_status", ["success", "retry", "failed"]);

// F02: 教員入力の種別（音声 / チャット）
export const teacherInputType = pgEnum("teacher_input_type", ["voice", "chat"]);

// F02: 教員入力のライフサイクル状態
//   draft        … 下書き保存（FR-06）
//   transcribing … 音声文字起こし待ち / 処理中（F02 スコープ外ジョブが更新、TODO）
//   ready        … 文字起こし完了・確認/編集可能（FR-04）
//   submitted    … F03 へ送信済み（FR-07: submitted_at をセット）
export const teacherInputStatus = pgEnum("teacher_input_status", [
  "draft",
  "transcribing",
  "ready",
  "submitted",
]);

// 監査ログ操作種別
export const auditOp = pgEnum("audit_op", ["insert", "update", "delete"]);

// CRM 系
export const contractStatus = pgEnum("contract_status", [
  "draft",
  "active",
  "paused",
  "terminated",
]);
export const communicationChannel = pgEnum("communication_channel", [
  "email",
  "phone",
  "meeting",
  "other",
]);

// F0 (V1 移植): 学校 → 学年 → クラス（→ 学科）階層スコープ。
// ads / daily_data / school_configs が「どの階層に紐づくか」を判別する discriminator。
export const hierarchyScope = pgEnum("hierarchy_scope", ["school", "grade", "class", "department"]);

// 学校設定の種別（V1 config sub-collection: display_settings / quiet_hours / schedule_templates）
export const configKind = pgEnum("config_kind", [
  "display_settings",
  "quiet_hours",
  "schedule_templates",
]);

// サイネージ広告のメディア種別（V1 Ad.type）
export const adMediaType = pgEnum("ad_media_type", ["image", "video"]);

// 学校の階層モード（V1 schools.hierarchyMode）。
//   class      … 学年 > クラス（普通科高校の標準）
//   department … 学年 > 学科 > クラス（学科制の高校）
// V1 setSchoolHierarchyMode 相当の切替対象（#48-L / #123）。
export const schoolHierarchyMode = pgEnum("school_hierarchy_mode", ["class", "department"]);

/**
 * 学校の階層モードの型（単一ソース）。アプリ層 (apps/web) は `import type` でこれを引き込み、
 * `satisfies readonly SchoolHierarchyMode[]` で許可値配列が enum とズレないことをコンパイル時に
 * 強制する (`client.ts` の `TenantRole` / `PublishScope` と同方針)。型のみなので Next バンドルに
 * enum のランタイム値を引き込まない。
 */
export type SchoolHierarchyMode = (typeof schoolHierarchyMode.enumValues)[number];
