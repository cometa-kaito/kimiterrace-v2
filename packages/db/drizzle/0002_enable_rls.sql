-- Row Level Security の有効化
-- ADR-019 (RLS 二層) に基づき、school_id でテナント分離するすべてのテーブルで RLS を ON。
-- policy 自体は 0003_rls_policies.sql で付与する。
--
-- RLS 対象 (school_id 持ち, NOT NULL):
--   users, classes, memberships, magic_links, contents, content_versions,
--   publishes, events, ai_extractions, ai_chat_sessions, ai_chat_messages, monthly_reports
--
-- RLS 対象 (schools 自身):
--   schools — id をテナント識別子として RLS する（system_admin のみ cross-tenant 参照可）
--
-- RLS 対象外 (cross-tenant, ADR-019):
--   advertisers, contracts, communications, system_admins (CRM テーブル)
--   audit_log (cross-tenant、append-only は 0004 で trigger 強制)
--
-- 関連: ADR-019, CLAUDE.md ルール 2, NFR03

-- テナント分離対象テーブル
ALTER TABLE "schools" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "classes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "magic_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "contents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "content_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "publishes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai_extractions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai_chat_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai_chat_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "monthly_reports" ENABLE ROW LEVEL SECURITY;
