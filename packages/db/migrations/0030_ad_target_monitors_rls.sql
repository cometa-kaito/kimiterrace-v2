-- =====================================================================
-- 0030_ad_target_monitors_rls.sql
-- 目的: Phase5（運営整理 G）で追加した広告⇄個別モニタ中間表 ad_target_monitors に
--       RLS（ads と同じ二層モデル）+ 監査 FK を付与する。
--
-- 前提: drizzle/<timestamp>_ad_target_monitors.sql でテーブルが作成済であること
--       （auto-discovery が drizzle/ → migrations/ の順で適用するため本ファイルが後）。
--
-- ★ ads（0006_f0a_schema_rls.sql）と同一の二層 RLS（ADR-019 / ルール2）:
--   - tenant_isolation        … school_id = app.current_school_id（学校ロール＝サイネージ配信読取が自校分のみ）
--   - system_admin_full_access… app.current_user_role = 'system_admin'（Partner API K3 が全校横断に書ける）
--   contract_contents（system_admin_only）と違い、サイネージ側の tenant 読取が要るため school_id を保持し
--   tenant_isolation を貼る（モニタ単位配信の読取は PR2 で本表を security_invoker view 経由で辿る）。
-- =====================================================================

-- 1) RLS 有効化
ALTER TABLE ad_target_monitors ENABLE ROW LEVEL SECURITY;

-- 2) tenant_isolation（学校テナント＝自校分のみ）
DROP POLICY IF EXISTS tenant_isolation ON ad_target_monitors;
CREATE POLICY tenant_isolation ON ad_target_monitors FOR ALL
  USING (school_id = NULLIF(current_setting('app.current_school_id', true), '')::uuid)
  WITH CHECK (school_id = NULLIF(current_setting('app.current_school_id', true), '')::uuid);

-- 3) system_admin_full_access（Partner API K3 / 運営 = 全校横断）
DROP POLICY IF EXISTS system_admin_full_access ON ad_target_monitors;
CREATE POLICY system_admin_full_access ON ad_target_monitors FOR ALL
  USING (current_setting('app.current_user_role', true) = 'system_admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'system_admin');

-- 4) 監査 FK: created_by / updated_by → users(id) ON DELETE SET NULL（K3 由来の書き込みは null）
ALTER TABLE ad_target_monitors DROP CONSTRAINT IF EXISTS ad_target_monitors_created_by_users_fk;
ALTER TABLE ad_target_monitors ADD CONSTRAINT ad_target_monitors_created_by_users_fk
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE ad_target_monitors DROP CONSTRAINT IF EXISTS ad_target_monitors_updated_by_users_fk;
ALTER TABLE ad_target_monitors ADD CONSTRAINT ad_target_monitors_updated_by_users_fk
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL;
