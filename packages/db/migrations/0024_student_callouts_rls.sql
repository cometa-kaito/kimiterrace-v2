-- =====================================================================
-- 0024_student_callouts_rls.sql
-- 目的: パターン2「生徒呼び出し」で追加した student_callouts に
--       RLS（テナント分離）+ 監査 FK を付与する。
--
-- 前提: drizzle/<timestamp>_*.sql で student_callouts が作成済であること
--       （auto-discovery が drizzle/ → migrations/ の順で適用するため本ファイルが後）。
--
-- 構成（既存 0016/0021/0023 と同一パターン、対象 1 テーブル）:
--   1. ENABLE ROW LEVEL SECURITY
--   2. tenant_isolation policy（school_id 一致、FOR ALL、USING + WITH CHECK）
--   3. system_admin_full_access policy（role = 'system_admin'、cross-tenant 運用）
--   4. created_by / updated_by → users(id) FK（ON DELETE SET NULL、循環依存回避の後付け）
--
-- ADR-019 二層 RLS モデル / CLAUDE.md ルール1・2 / 生徒実名表示の境界は ADR-034 準拠。
-- 編集は school_admin / teacher（自校 = tenant_isolation）、サイネージ読み取りは匿名だが
-- withTenantContext で school を pin して読む（手書き WHERE school_id に依存しない）。
-- =====================================================================

-- 1) RLS 有効化
ALTER TABLE student_callouts ENABLE ROW LEVEL SECURITY;

-- 2) tenant_isolation policy（school_id 一致）
DROP POLICY IF EXISTS tenant_isolation ON student_callouts;
CREATE POLICY tenant_isolation ON student_callouts FOR ALL
  USING (school_id = NULLIF(current_setting('app.current_school_id', true), '')::uuid)
  WITH CHECK (school_id = NULLIF(current_setting('app.current_school_id', true), '')::uuid);

-- 3) system_admin_full_access policy（cross-tenant、role = 'system_admin'）
DROP POLICY IF EXISTS system_admin_full_access ON student_callouts;
CREATE POLICY system_admin_full_access ON student_callouts FOR ALL
  USING (current_setting('app.current_user_role', true) = 'system_admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'system_admin');

-- 4) 監査 FK: created_by / updated_by → users(id) ON DELETE SET NULL
ALTER TABLE student_callouts DROP CONSTRAINT IF EXISTS student_callouts_created_by_users_fk;
ALTER TABLE student_callouts
  ADD CONSTRAINT student_callouts_created_by_users_fk
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE student_callouts DROP CONSTRAINT IF EXISTS student_callouts_updated_by_users_fk;
ALTER TABLE student_callouts
  ADD CONSTRAINT student_callouts_updated_by_users_fk
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL;
