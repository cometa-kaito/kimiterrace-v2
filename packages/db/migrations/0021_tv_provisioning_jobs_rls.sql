-- =====================================================================
-- 0021_tv_provisioning_jobs_rls.sql
-- 目的: C方式 TV プロビジョニングで追加した tv_provisioning_jobs に
--       RLS（テナント分離）+ 監査 FK を付与する。
--
-- 前提: drizzle/<timestamp>_*.sql で tv_provisioning_jobs が作成済であること
--       （auto-discovery が drizzle/ → migrations/ の順で適用するため本ファイルが後）。
--
-- 構成（既存 0016_tv_devices_rls.sql と同一パターン、対象 1 テーブル）:
--   1. ENABLE ROW LEVEL SECURITY
--   2. tenant_isolation policy（school_id 一致、FOR ALL、USING + WITH CHECK）
--   3. system_admin_full_access policy（role = 'system_admin'）
--   4. created_by / updated_by → users(id) FK（ON DELETE SET NULL）
--
-- ADR-019 二層 RLS モデル / CLAUDE.md ルール1・2 準拠。
-- 注: 作成は system_admin（cross-tenant、ONBOARDING_ROLES）。claim / status 報告（エージェント API、
--     セッション無し）は system_admin role context で cross-tenant 解決する（pollTvConfig と同じ二層）。
-- =====================================================================

-- 1) RLS 有効化
ALTER TABLE tv_provisioning_jobs ENABLE ROW LEVEL SECURITY;

-- 2) tenant_isolation policy
DROP POLICY IF EXISTS tenant_isolation ON tv_provisioning_jobs;
CREATE POLICY tenant_isolation ON tv_provisioning_jobs FOR ALL
  USING (school_id = NULLIF(current_setting('app.current_school_id', true), '')::uuid)
  WITH CHECK (school_id = NULLIF(current_setting('app.current_school_id', true), '')::uuid);

-- 3) system_admin_full_access policy（cross-tenant、role = 'system_admin'）
DROP POLICY IF EXISTS system_admin_full_access ON tv_provisioning_jobs;
CREATE POLICY system_admin_full_access ON tv_provisioning_jobs FOR ALL
  USING (current_setting('app.current_user_role', true) = 'system_admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'system_admin');

-- 4) 監査 FK: created_by / updated_by → users(id) ON DELETE SET NULL
ALTER TABLE tv_provisioning_jobs DROP CONSTRAINT IF EXISTS tv_provisioning_jobs_created_by_users_fk;
ALTER TABLE tv_provisioning_jobs
  ADD CONSTRAINT tv_provisioning_jobs_created_by_users_fk
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE tv_provisioning_jobs DROP CONSTRAINT IF EXISTS tv_provisioning_jobs_updated_by_users_fk;
ALTER TABLE tv_provisioning_jobs
  ADD CONSTRAINT tv_provisioning_jobs_updated_by_users_fk
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL;
