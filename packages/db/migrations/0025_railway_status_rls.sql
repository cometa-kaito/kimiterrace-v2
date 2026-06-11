-- =====================================================================
-- 0025_railway_status_rls.sql
-- 目的: パターン2「鉄道」（ADR-035）で追加した運行情報キャッシュ railway_status に
--       RLS（公開参照マスタの特例パターン）+ 監査 FK を付与する。
--
-- 前提: drizzle/<timestamp>_*.sql で railway_status が作成済であること
--       （auto-discovery が drizzle/ → migrations/ の順で適用するため本ファイルが後）。
--
-- ★ weather_forecasts（0017）と同一の二本立て（ADR-019 §公開参照マスタ特例 / ルール6）:
--   - railway_status は **school_id を持たない 公開・非 PII の共有キャッシュ**（運行情報は公開情報）。
--   - (a) railway_status_read_all    … FOR SELECT USING (true) = 全ロール / 匿名サイネージも読める
--   - (b) railway_status_write_system… INSERT/UPDATE/DELETE は system_admin のみ = 取得 Job だけが書く
--   SELECT 全開放は「school_id 非保持 かつ 公開・非 PII」を満たすため許される特例。生 PII を列に入れない
--   （氏名等を足す変更は本特例の前提を壊すので不可。ADR-035）。サイネージ匿名読取（ADR-016）が確実に読める。
-- =====================================================================

-- 1) RLS 有効化（ENABLE のみ）
ALTER TABLE railway_status ENABLE ROW LEVEL SECURITY;

-- 2) railway_status_read_all（FOR SELECT, USING (true)）= 全ロール + 匿名サイネージが読める
DROP POLICY IF EXISTS railway_status_read_all ON railway_status;
CREATE POLICY railway_status_read_all ON railway_status FOR SELECT
  USING (true);

-- 3) railway_status_write_system（INSERT/UPDATE/DELETE は system_admin のみ）= 取得 Job だけが upsert
DROP POLICY IF EXISTS railway_status_write_system_insert ON railway_status;
CREATE POLICY railway_status_write_system_insert ON railway_status FOR INSERT
  WITH CHECK (current_setting('app.current_user_role', true) = 'system_admin');

DROP POLICY IF EXISTS railway_status_write_system_update ON railway_status;
CREATE POLICY railway_status_write_system_update ON railway_status FOR UPDATE
  USING (current_setting('app.current_user_role', true) = 'system_admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'system_admin');

DROP POLICY IF EXISTS railway_status_write_system_delete ON railway_status;
CREATE POLICY railway_status_write_system_delete ON railway_status FOR DELETE
  USING (current_setting('app.current_user_role', true) = 'system_admin');

-- 4) 監査 FK: created_by / updated_by → users(id) ON DELETE SET NULL（取得 Job の書き込みは null）
ALTER TABLE railway_status DROP CONSTRAINT IF EXISTS railway_status_created_by_users_fk;
ALTER TABLE railway_status
  ADD CONSTRAINT railway_status_created_by_users_fk
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE railway_status DROP CONSTRAINT IF EXISTS railway_status_updated_by_users_fk;
ALTER TABLE railway_status
  ADD CONSTRAINT railway_status_updated_by_users_fk
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL;
