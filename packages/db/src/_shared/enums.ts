import { pgEnum } from "drizzle-orm/pg-core";

// 役割: テナント内ユーザーのロール（system_admin はテナント外、system_admins テーブルで管理）
export const userRole = pgEnum("user_role", ["school_admin", "teacher", "student", "guardian"]);

// コンテンツ発行スコープ（F01-F04）
export const publishScope = pgEnum("publish_scope", ["school", "class", "homeroom", "private"]);

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
