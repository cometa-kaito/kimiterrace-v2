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

// 行動イベント種別（F07）
export const eventType = pgEnum("event_type", ["view", "tap", "dwell", "ask"]);

// AI 抽出種別（F03）
export const aiExtractionKind = pgEnum("ai_extraction_kind", [
  "schedule",
  "announcement",
  "summary",
  "tag",
]);

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
