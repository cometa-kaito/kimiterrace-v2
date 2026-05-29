-- =====================================================================
-- 0002_rls_policies.sql
-- 目的: RLS policy + DB ロール + 権限 (ADR-019 二層モデル)
--
-- レイヤー 1: tenant_isolation policy (school_id 一致)
-- レイヤー 2: system_admin_full_access policy (role = 'system_admin')
--
-- 複数 PERMISSIVE policy は OR で結合されるため、
--   - school_admin/teacher/student/guardian: tenant_isolation のみ通る
--   - system_admin: system_admin_full_access が通り全件可視
--   - context 未設定: どちらも通らず拒否 (deny by default)
--
-- セッション設定キー:
--   - app.current_school_id (uuid)
--   - app.current_user_role ('system_admin' | 'school_admin' | ...)
--   - app.current_user_id    (uuid, audit trigger 用)
-- =====================================================================

-- ---------------------------------------------------------------------
-- DB ロール (BYPASSRLS は migrator のみ、CLAUDE.md ルール2)
--   - kimiterrace_migrator: drizzle-kit migrate 用、BYPASSRLS
--   - kimiterrace_app:      Cloud Run からの通常接続用、BYPASSRLS なし
--   - kimiterrace_readonly: 分析・dashboard 用 (将来)、BYPASSRLS なし
-- 既存ロールがあれば作成スキップ。
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kimiterrace_migrator') THEN
    CREATE ROLE kimiterrace_migrator NOLOGIN BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kimiterrace_app') THEN
    CREATE ROLE kimiterrace_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kimiterrace_readonly') THEN
    CREATE ROLE kimiterrace_readonly NOLOGIN;
  END IF;
END
$$;

-- ---------------------------------------------------------------------
-- ヘルパー: tenant_isolation policy を全テナント分離テーブルに貼る
--
-- ALL コマンド (SELECT/INSERT/UPDATE/DELETE) に対して USING + WITH CHECK 両方を効かせる:
--   - USING:      既存行が可視か (SELECT/UPDATE/DELETE)
--   - WITH CHECK: 新規行が許可されるか (INSERT/UPDATE)
-- WITH CHECK を入れないと、他テナントの school_id で INSERT 可能になる脆弱性が残る。
-- ---------------------------------------------------------------------

-- users
DROP POLICY IF EXISTS tenant_isolation ON users;
CREATE POLICY tenant_isolation ON users FOR ALL
  USING (school_id = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK (school_id = current_setting('app.current_school_id', true)::uuid);

-- classes
DROP POLICY IF EXISTS tenant_isolation ON classes;
CREATE POLICY tenant_isolation ON classes FOR ALL
  USING (school_id = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK (school_id = current_setting('app.current_school_id', true)::uuid);

-- memberships
DROP POLICY IF EXISTS tenant_isolation ON memberships;
CREATE POLICY tenant_isolation ON memberships FOR ALL
  USING (school_id = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK (school_id = current_setting('app.current_school_id', true)::uuid);

-- magic_links
DROP POLICY IF EXISTS tenant_isolation ON magic_links;
CREATE POLICY tenant_isolation ON magic_links FOR ALL
  USING (school_id = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK (school_id = current_setting('app.current_school_id', true)::uuid);

-- contents
DROP POLICY IF EXISTS tenant_isolation ON contents;
CREATE POLICY tenant_isolation ON contents FOR ALL
  USING (school_id = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK (school_id = current_setting('app.current_school_id', true)::uuid);

-- content_versions
DROP POLICY IF EXISTS tenant_isolation ON content_versions;
CREATE POLICY tenant_isolation ON content_versions FOR ALL
  USING (school_id = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK (school_id = current_setting('app.current_school_id', true)::uuid);

-- publishes
DROP POLICY IF EXISTS tenant_isolation ON publishes;
CREATE POLICY tenant_isolation ON publishes FOR ALL
  USING (school_id = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK (school_id = current_setting('app.current_school_id', true)::uuid);

-- events
DROP POLICY IF EXISTS tenant_isolation ON events;
CREATE POLICY tenant_isolation ON events FOR ALL
  USING (school_id = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK (school_id = current_setting('app.current_school_id', true)::uuid);

-- ai_extractions
DROP POLICY IF EXISTS tenant_isolation ON ai_extractions;
CREATE POLICY tenant_isolation ON ai_extractions FOR ALL
  USING (school_id = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK (school_id = current_setting('app.current_school_id', true)::uuid);

-- ai_chat_sessions
DROP POLICY IF EXISTS tenant_isolation ON ai_chat_sessions;
CREATE POLICY tenant_isolation ON ai_chat_sessions FOR ALL
  USING (school_id = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK (school_id = current_setting('app.current_school_id', true)::uuid);

-- ai_chat_messages
DROP POLICY IF EXISTS tenant_isolation ON ai_chat_messages;
CREATE POLICY tenant_isolation ON ai_chat_messages FOR ALL
  USING (school_id = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK (school_id = current_setting('app.current_school_id', true)::uuid);

-- monthly_reports
DROP POLICY IF EXISTS tenant_isolation ON monthly_reports;
CREATE POLICY tenant_isolation ON monthly_reports FOR ALL
  USING (school_id = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK (school_id = current_setting('app.current_school_id', true)::uuid);

-- ---------------------------------------------------------------------
-- system_admin_full_access policy (全 RLS テーブルに付与)
--   role = 'system_admin' なら全件可視 (cross-tenant)
-- ---------------------------------------------------------------------

-- テナント分離テーブル
DROP POLICY IF EXISTS system_admin_full_access ON users;
CREATE POLICY system_admin_full_access ON users FOR ALL
  USING (current_setting('app.current_user_role', true) = 'system_admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'system_admin');

DROP POLICY IF EXISTS system_admin_full_access ON classes;
CREATE POLICY system_admin_full_access ON classes FOR ALL
  USING (current_setting('app.current_user_role', true) = 'system_admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'system_admin');

DROP POLICY IF EXISTS system_admin_full_access ON memberships;
CREATE POLICY system_admin_full_access ON memberships FOR ALL
  USING (current_setting('app.current_user_role', true) = 'system_admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'system_admin');

DROP POLICY IF EXISTS system_admin_full_access ON magic_links;
CREATE POLICY system_admin_full_access ON magic_links FOR ALL
  USING (current_setting('app.current_user_role', true) = 'system_admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'system_admin');

DROP POLICY IF EXISTS system_admin_full_access ON contents;
CREATE POLICY system_admin_full_access ON contents FOR ALL
  USING (current_setting('app.current_user_role', true) = 'system_admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'system_admin');

DROP POLICY IF EXISTS system_admin_full_access ON content_versions;
CREATE POLICY system_admin_full_access ON content_versions FOR ALL
  USING (current_setting('app.current_user_role', true) = 'system_admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'system_admin');

DROP POLICY IF EXISTS system_admin_full_access ON publishes;
CREATE POLICY system_admin_full_access ON publishes FOR ALL
  USING (current_setting('app.current_user_role', true) = 'system_admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'system_admin');

DROP POLICY IF EXISTS system_admin_full_access ON events;
CREATE POLICY system_admin_full_access ON events FOR ALL
  USING (current_setting('app.current_user_role', true) = 'system_admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'system_admin');

DROP POLICY IF EXISTS system_admin_full_access ON ai_extractions;
CREATE POLICY system_admin_full_access ON ai_extractions FOR ALL
  USING (current_setting('app.current_user_role', true) = 'system_admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'system_admin');

DROP POLICY IF EXISTS system_admin_full_access ON ai_chat_sessions;
CREATE POLICY system_admin_full_access ON ai_chat_sessions FOR ALL
  USING (current_setting('app.current_user_role', true) = 'system_admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'system_admin');

DROP POLICY IF EXISTS system_admin_full_access ON ai_chat_messages;
CREATE POLICY system_admin_full_access ON ai_chat_messages FOR ALL
  USING (current_setting('app.current_user_role', true) = 'system_admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'system_admin');

DROP POLICY IF EXISTS system_admin_full_access ON monthly_reports;
CREATE POLICY system_admin_full_access ON monthly_reports FOR ALL
  USING (current_setting('app.current_user_role', true) = 'system_admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'system_admin');

-- CRM / cross-tenant テーブル: system_admin のみアクセス可
DROP POLICY IF EXISTS system_admin_full_access ON schools;
CREATE POLICY system_admin_full_access ON schools FOR ALL
  USING (current_setting('app.current_user_role', true) = 'system_admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'system_admin');

DROP POLICY IF EXISTS system_admin_full_access ON advertisers;
CREATE POLICY system_admin_full_access ON advertisers FOR ALL
  USING (current_setting('app.current_user_role', true) = 'system_admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'system_admin');

DROP POLICY IF EXISTS system_admin_full_access ON contracts;
CREATE POLICY system_admin_full_access ON contracts FOR ALL
  USING (current_setting('app.current_user_role', true) = 'system_admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'system_admin');

DROP POLICY IF EXISTS system_admin_full_access ON communications;
CREATE POLICY system_admin_full_access ON communications FOR ALL
  USING (current_setting('app.current_user_role', true) = 'system_admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'system_admin');

DROP POLICY IF EXISTS system_admin_full_access ON system_admins;
CREATE POLICY system_admin_full_access ON system_admins FOR ALL
  USING (current_setting('app.current_user_role', true) = 'system_admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'system_admin');

-- ---------------------------------------------------------------------
-- schools のテナント可読 policy: 学校管理者は自校のレコードだけ参照可
-- (system_admin 以外の他テーブル参照で schools への JOIN が発生する場合に備え、
--  read-only な policy を1つ追加)
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS tenant_self_read ON schools;
CREATE POLICY tenant_self_read ON schools FOR SELECT
  USING (id = current_setting('app.current_school_id', true)::uuid);

-- ---------------------------------------------------------------------
-- audit_log: 読み取りは自テナント or system_admin、書き込みは INSERT のみ
-- (UPDATE/DELETE は 0003_audit_trigger.sql のトリガで物理的に拒否)
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS audit_log_tenant_read ON audit_log;
CREATE POLICY audit_log_tenant_read ON audit_log FOR SELECT
  USING (
    school_id = current_setting('app.current_school_id', true)::uuid
    OR current_setting('app.current_user_role', true) = 'system_admin'
  );

DROP POLICY IF EXISTS audit_log_insert ON audit_log;
CREATE POLICY audit_log_insert ON audit_log FOR INSERT
  WITH CHECK (
    -- 任意のセッションが INSERT 可能 (誰がやったかは actor_user_id / actor_identity_uid に記録)
    -- school_id は null (cross-tenant 操作) または現在の school_id に一致のみ許可
    school_id IS NULL
    OR school_id = current_setting('app.current_school_id', true)::uuid
    OR current_setting('app.current_user_role', true) = 'system_admin'
  );

-- ---------------------------------------------------------------------
-- 権限付与 (BYPASSRLS は migrator のみ、app/admin には付与しない)
-- ---------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO kimiterrace_app, kimiterrace_readonly;

-- app: 全テーブル CRUD (RLS で守る)
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO kimiterrace_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO kimiterrace_app;

-- readonly: SELECT のみ
GRANT SELECT ON ALL TABLES IN SCHEMA public TO kimiterrace_readonly;

-- 今後追加されるテーブルにも自動付与
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO kimiterrace_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO kimiterrace_readonly;
