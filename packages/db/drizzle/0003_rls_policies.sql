-- RLS ポリシー（テナント分離 + system_admin cross-tenant）
-- ADR-019 の二層モデル:
--   レイヤー 1: tenant_isolation        — school_id 一致のみ可視
--   レイヤー 2: system_admin_full_access — current_user_role = 'system_admin' は全件可視
--
-- 重要なお作法:
--   - PostgreSQL の `current_setting('xxx', true)` は missing_ok=true、未設定時は NULL を返す。
--     `school_id = NULL` は False になるので **未設定時は自動的に拒否**（fail-closed）。
--   - 同じテーブルに複数 PERMISSIVE policy がある場合は OR 結合。
--     そのため system_admin policy が true を返せば tenant 不一致でも可視になる。
--   - ALL FOR は SELECT/INSERT/UPDATE/DELETE 全てに適用される。
--
-- 関連: ADR-019, CLAUDE.md ルール 2, NFR03

------------------------------------------------------------
-- schools : id 自体がテナント識別子
------------------------------------------------------------
CREATE POLICY tenant_isolation ON "schools"
  FOR ALL
  USING (id = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK (id = current_setting('app.current_school_id', true)::uuid);
--> statement-breakpoint
CREATE POLICY system_admin_full_access ON "schools"
  FOR ALL
  USING (current_setting('app.current_user_role', true) = 'system_admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'system_admin');
--> statement-breakpoint

------------------------------------------------------------
-- users
------------------------------------------------------------
CREATE POLICY tenant_isolation ON "users"
  FOR ALL
  USING (school_id = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK (school_id = current_setting('app.current_school_id', true)::uuid);
--> statement-breakpoint
CREATE POLICY system_admin_full_access ON "users"
  FOR ALL
  USING (current_setting('app.current_user_role', true) = 'system_admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'system_admin');
--> statement-breakpoint

------------------------------------------------------------
-- classes
------------------------------------------------------------
CREATE POLICY tenant_isolation ON "classes"
  FOR ALL
  USING (school_id = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK (school_id = current_setting('app.current_school_id', true)::uuid);
--> statement-breakpoint
CREATE POLICY system_admin_full_access ON "classes"
  FOR ALL
  USING (current_setting('app.current_user_role', true) = 'system_admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'system_admin');
--> statement-breakpoint

------------------------------------------------------------
-- memberships
------------------------------------------------------------
CREATE POLICY tenant_isolation ON "memberships"
  FOR ALL
  USING (school_id = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK (school_id = current_setting('app.current_school_id', true)::uuid);
--> statement-breakpoint
CREATE POLICY system_admin_full_access ON "memberships"
  FOR ALL
  USING (current_setting('app.current_user_role', true) = 'system_admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'system_admin');
--> statement-breakpoint

------------------------------------------------------------
-- magic_links
------------------------------------------------------------
CREATE POLICY tenant_isolation ON "magic_links"
  FOR ALL
  USING (school_id = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK (school_id = current_setting('app.current_school_id', true)::uuid);
--> statement-breakpoint
CREATE POLICY system_admin_full_access ON "magic_links"
  FOR ALL
  USING (current_setting('app.current_user_role', true) = 'system_admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'system_admin');
--> statement-breakpoint

------------------------------------------------------------
-- contents
------------------------------------------------------------
CREATE POLICY tenant_isolation ON "contents"
  FOR ALL
  USING (school_id = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK (school_id = current_setting('app.current_school_id', true)::uuid);
--> statement-breakpoint
CREATE POLICY system_admin_full_access ON "contents"
  FOR ALL
  USING (current_setting('app.current_user_role', true) = 'system_admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'system_admin');
--> statement-breakpoint

------------------------------------------------------------
-- content_versions
------------------------------------------------------------
CREATE POLICY tenant_isolation ON "content_versions"
  FOR ALL
  USING (school_id = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK (school_id = current_setting('app.current_school_id', true)::uuid);
--> statement-breakpoint
CREATE POLICY system_admin_full_access ON "content_versions"
  FOR ALL
  USING (current_setting('app.current_user_role', true) = 'system_admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'system_admin');
--> statement-breakpoint

------------------------------------------------------------
-- publishes
------------------------------------------------------------
CREATE POLICY tenant_isolation ON "publishes"
  FOR ALL
  USING (school_id = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK (school_id = current_setting('app.current_school_id', true)::uuid);
--> statement-breakpoint
CREATE POLICY system_admin_full_access ON "publishes"
  FOR ALL
  USING (current_setting('app.current_user_role', true) = 'system_admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'system_admin');
--> statement-breakpoint

------------------------------------------------------------
-- events
------------------------------------------------------------
CREATE POLICY tenant_isolation ON "events"
  FOR ALL
  USING (school_id = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK (school_id = current_setting('app.current_school_id', true)::uuid);
--> statement-breakpoint
CREATE POLICY system_admin_full_access ON "events"
  FOR ALL
  USING (current_setting('app.current_user_role', true) = 'system_admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'system_admin');
--> statement-breakpoint

------------------------------------------------------------
-- ai_extractions
------------------------------------------------------------
CREATE POLICY tenant_isolation ON "ai_extractions"
  FOR ALL
  USING (school_id = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK (school_id = current_setting('app.current_school_id', true)::uuid);
--> statement-breakpoint
CREATE POLICY system_admin_full_access ON "ai_extractions"
  FOR ALL
  USING (current_setting('app.current_user_role', true) = 'system_admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'system_admin');
--> statement-breakpoint

------------------------------------------------------------
-- ai_chat_sessions
------------------------------------------------------------
CREATE POLICY tenant_isolation ON "ai_chat_sessions"
  FOR ALL
  USING (school_id = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK (school_id = current_setting('app.current_school_id', true)::uuid);
--> statement-breakpoint
CREATE POLICY system_admin_full_access ON "ai_chat_sessions"
  FOR ALL
  USING (current_setting('app.current_user_role', true) = 'system_admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'system_admin');
--> statement-breakpoint

------------------------------------------------------------
-- ai_chat_messages
------------------------------------------------------------
CREATE POLICY tenant_isolation ON "ai_chat_messages"
  FOR ALL
  USING (school_id = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK (school_id = current_setting('app.current_school_id', true)::uuid);
--> statement-breakpoint
CREATE POLICY system_admin_full_access ON "ai_chat_messages"
  FOR ALL
  USING (current_setting('app.current_user_role', true) = 'system_admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'system_admin');
--> statement-breakpoint

------------------------------------------------------------
-- monthly_reports
------------------------------------------------------------
CREATE POLICY tenant_isolation ON "monthly_reports"
  FOR ALL
  USING (school_id = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK (school_id = current_setting('app.current_school_id', true)::uuid);
--> statement-breakpoint
CREATE POLICY system_admin_full_access ON "monthly_reports"
  FOR ALL
  USING (current_setting('app.current_user_role', true) = 'system_admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'system_admin');
