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
