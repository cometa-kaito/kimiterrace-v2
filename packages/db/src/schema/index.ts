// 全テーブルの公開エクスポート。drizzle-kit はこのファイルから schema を辿る。
// enum も明示 re-export しないと drizzle-kit がスナップショットに enum を登録できず、
// generate のたびに既存 enum の DROP TYPE を吐く (Issue #101 / PR #104 の真因)。
export * from "../_shared/enums.js";
export * from "./schools.js";
export * from "./users.js";
export * from "./classes.js";
export * from "./memberships.js";
export * from "./magic-links.js";
export * from "./contents.js";
export * from "./content-versions.js";
export * from "./publishes.js";
export * from "./events.js";
export * from "./ai-extractions.js";
export * from "./ai-chat-sessions.js";
export * from "./ai-chat-messages.js";
// Part C1: CRM + cross-tenant
export * from "./advertisers.js";
export * from "./contracts.js";
export * from "./communications.js";
export * from "./monthly-reports.js";
export * from "./system-admins.js";
export * from "./audit-log.js";
// F0 (#48-A): V1 移植 — 階層基盤テーブル
export * from "./grades.js";
export * from "./departments.js";
export * from "./school-configs.js";
export * from "./daily-data.js";
export * from "./ads.js";
// F0 (#48-F): 広告階層マージ VIEW (実体は migrations/0007、ここは型定義のみ)
export * from "./effective-ads-view.js";
