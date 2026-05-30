-- =====================================================================
-- 0008_f02_schema_rls.sql
-- 目的: F02 で追加した teacher_inputs / teacher_input_attachments に
--       RLS + 監査 FK を付与する。
--
-- 対象テーブル (いずれも school_id を持つテナント分離テーブル):
--   teacher_inputs / teacher_input_attachments
--
-- 前提: drizzle/0003_f02_teacher_inputs.sql で 2 テーブルが作成済であること。
--
-- 構成 (既存 0002/0006 と同一パターン):
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
ALTER TABLE teacher_inputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE teacher_inputs FORCE ROW LEVEL SECURITY;
ALTER TABLE teacher_input_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE teacher_input_attachments FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------
-- 2) tenant_isolation policy
--    USING: 既存行が可視か / WITH CHECK: 新規行が許可されるか
--    NULLIF(..., '') は current_setting の missing_ok モードが空文字を返す
--    ケースの fail-closed 対策 (既存 policy 全体に適用済のパターン)。
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS tenant_isolation ON teacher_inputs;
CREATE POLICY tenant_isolation ON teacher_inputs FOR ALL
  USING (school_id = NULLIF(current_setting('app.current_school_id', true), '')::uuid)
  WITH CHECK (school_id = NULLIF(current_setting('app.current_school_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON teacher_input_attachments;
CREATE POLICY tenant_isolation ON teacher_input_attachments FOR ALL
  USING (school_id = NULLIF(current_setting('app.current_school_id', true), '')::uuid)
  WITH CHECK (school_id = NULLIF(current_setting('app.current_school_id', true), '')::uuid);

-- ---------------------------------------------------------------------
-- 3) system_admin_full_access policy (cross-tenant、role = 'system_admin')
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS system_admin_full_access ON teacher_inputs;
CREATE POLICY system_admin_full_access ON teacher_inputs FOR ALL
  USING (current_setting('app.current_user_role', true) = 'system_admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'system_admin');

DROP POLICY IF EXISTS system_admin_full_access ON teacher_input_attachments;
CREATE POLICY system_admin_full_access ON teacher_input_attachments FOR ALL
  USING (current_setting('app.current_user_role', true) = 'system_admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'system_admin');

-- ---------------------------------------------------------------------
-- 4) 監査 FK: created_by / updated_by → users(id) ON DELETE SET NULL
--    (src/_shared/audit.ts は循環依存回避で FK 未宣言。0004/0006 と同じ後付けパターン)
-- ---------------------------------------------------------------------
DO $$
DECLARE
  t text;
  tables text[] := ARRAY['teacher_inputs', 'teacher_input_attachments'];
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
