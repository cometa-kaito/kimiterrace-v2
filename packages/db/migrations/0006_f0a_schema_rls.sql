-- =====================================================================
-- 0006_f0a_schema_rls.sql
-- 目的: F0 (#48-A) V1 移植で追加した階層基盤テーブルに RLS + 監査 FK を付与。
--
-- 対象テーブル (すべて school_id を持つテナント分離テーブル):
--   grades / departments / school_configs / daily_data / ads
--
-- 前提: drizzle/0001_f0a_hierarchy_tables.sql で 5 テーブルが作成済であること。
--
-- 構成 (既存 0001/0002/0004 と同一パターン):
--   1. ENABLE ROW LEVEL SECURITY
--   2. tenant_isolation policy (school_id 一致、FOR ALL、USING + WITH CHECK)
--   3. system_admin_full_access policy (role = 'system_admin')
--   4. created_by / updated_by → users(id) FK (ON DELETE SET NULL)
--
-- ADR-019 二層 RLS モデル / CLAUDE.md ルール1・2 準拠。
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) RLS 有効化
-- ---------------------------------------------------------------------
ALTER TABLE grades ENABLE ROW LEVEL SECURITY;
ALTER TABLE departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE school_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_data ENABLE ROW LEVEL SECURITY;
ALTER TABLE ads ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------
-- 2) tenant_isolation policy
--    USING: 既存行が可視か / WITH CHECK: 新規行が許可されるか
--    NULLIF(..., '') は current_setting の missing_ok モードが空文字を返す
--    ケースの fail-closed 対策 (PR #99 で全 policy に適用済のパターン)。
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS tenant_isolation ON grades;
CREATE POLICY tenant_isolation ON grades FOR ALL
  USING (school_id = NULLIF(current_setting('app.current_school_id', true), '')::uuid)
  WITH CHECK (school_id = NULLIF(current_setting('app.current_school_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON departments;
CREATE POLICY tenant_isolation ON departments FOR ALL
  USING (school_id = NULLIF(current_setting('app.current_school_id', true), '')::uuid)
  WITH CHECK (school_id = NULLIF(current_setting('app.current_school_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON school_configs;
CREATE POLICY tenant_isolation ON school_configs FOR ALL
  USING (school_id = NULLIF(current_setting('app.current_school_id', true), '')::uuid)
  WITH CHECK (school_id = NULLIF(current_setting('app.current_school_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON daily_data;
CREATE POLICY tenant_isolation ON daily_data FOR ALL
  USING (school_id = NULLIF(current_setting('app.current_school_id', true), '')::uuid)
  WITH CHECK (school_id = NULLIF(current_setting('app.current_school_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON ads;
CREATE POLICY tenant_isolation ON ads FOR ALL
  USING (school_id = NULLIF(current_setting('app.current_school_id', true), '')::uuid)
  WITH CHECK (school_id = NULLIF(current_setting('app.current_school_id', true), '')::uuid);

-- ---------------------------------------------------------------------
-- 3) system_admin_full_access policy (cross-tenant、role = 'system_admin')
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS system_admin_full_access ON grades;
CREATE POLICY system_admin_full_access ON grades FOR ALL
  USING (current_setting('app.current_user_role', true) = 'system_admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'system_admin');

DROP POLICY IF EXISTS system_admin_full_access ON departments;
CREATE POLICY system_admin_full_access ON departments FOR ALL
  USING (current_setting('app.current_user_role', true) = 'system_admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'system_admin');

DROP POLICY IF EXISTS system_admin_full_access ON school_configs;
CREATE POLICY system_admin_full_access ON school_configs FOR ALL
  USING (current_setting('app.current_user_role', true) = 'system_admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'system_admin');

DROP POLICY IF EXISTS system_admin_full_access ON daily_data;
CREATE POLICY system_admin_full_access ON daily_data FOR ALL
  USING (current_setting('app.current_user_role', true) = 'system_admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'system_admin');

DROP POLICY IF EXISTS system_admin_full_access ON ads;
CREATE POLICY system_admin_full_access ON ads FOR ALL
  USING (current_setting('app.current_user_role', true) = 'system_admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'system_admin');

-- ---------------------------------------------------------------------
-- 4) 監査 FK: created_by / updated_by → users(id) ON DELETE SET NULL
--    (src/_shared/audit.ts は循環依存回避で FK 未宣言。0004 と同じ後付けパターン)
-- ---------------------------------------------------------------------
DO $$
DECLARE
  t text;
  tables text[] := ARRAY['grades', 'departments', 'school_configs', 'daily_data', 'ads'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format(
      'ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I',
      t, t || '_created_by_users_fk'
    );
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL',
      t, t || '_created_by_users_fk'
    );
    EXECUTE format(
      'ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I',
      t, t || '_updated_by_users_fk'
    );
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL',
      t, t || '_updated_by_users_fk'
    );
  END LOOP;
END
$$;
