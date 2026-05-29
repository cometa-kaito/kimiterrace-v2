-- =====================================================================
-- 0001_enable_rls.sql
-- 目的: 全テーブルに RLS を有効化する (CLAUDE.md ルール2 + ADR-019)
--
-- 対象:
--   - テナント分離テーブル (school_id を持つ): users, classes, memberships,
--     magic_links, contents, content_versions, publishes, events,
--     ai_extractions, ai_chat_sessions, ai_chat_messages, monthly_reports
--   - CRM/cross-tenant テーブル: schools, advertisers, contracts,
--     communications, system_admins
--   - audit_log (cross-tenant、append-only)
--
-- 後続:
--   - 0002_rls_policies.sql で policy を貼る
--   - 0003_audit_trigger.sql で audit_log のトリガを貼る
-- =====================================================================

-- ---------------------------------------------------------------------
-- テナント分離テーブル (school_id あり)
-- ---------------------------------------------------------------------
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE classes ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE magic_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE contents ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE publishes ENABLE ROW LEVEL SECURITY;
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_extractions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_chat_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE monthly_reports ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------
-- CRM / cross-tenant テーブル (school_id なし)
-- school_admin 以下は DB レベルでアクセス不可、system_admin のみ可
-- ---------------------------------------------------------------------
ALTER TABLE schools ENABLE ROW LEVEL SECURITY;
ALTER TABLE advertisers ENABLE ROW LEVEL SECURITY;
ALTER TABLE contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE communications ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_admins ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------
-- audit_log (cross-tenant、append-only)
-- 通常テーブルの ENABLE ROW LEVEL SECURITY だけだと、テーブル所有者は RLS を
-- バイパスする。FORCE で所有者にも policy を強制する (改竄防止)。
-- ---------------------------------------------------------------------
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
