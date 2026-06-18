-- =====================================================================
-- 0028_news_items_rls.sql
-- 目的: pattern2/3「工学ニュース」（ADR-043）で追加したニュース見出しキャッシュ news_items に
--       RLS（公開参照マスタの特例パターン）+ 監査 FK を付与する。
--
-- 前提: drizzle/<timestamp>_*.sql で news_items / news_source enum が作成済であること
--       （auto-discovery が drizzle/ → migrations/ の順で適用するため本ファイルが後）。
--
-- ★ weather_forecasts（0017）/ railway_status（0025）と同一の二本立て（ADR-019 §公開参照マスタ特例 / ルール2）:
--   - news_items は **school_id を持たない 公開・非 PII の共有キャッシュ**（ニュース見出し + 出典 URL のみ）。
--   - (a) news_items_read_all    … FOR SELECT USING (true) = 全ロール / 匿名サイネージも読める
--   - (b) news_items_write_system… INSERT/UPDATE/DELETE は system_admin のみ = 取得 Job だけが書く
--   SELECT 全開放は「school_id 非保持 かつ 公開・非 PII」を満たすため許される特例。本文・PII を列に入れない
--   （見出し + URL + メタのみ。本文を足す変更は本特例の前提を壊すので不可。ADR-043）。
-- =====================================================================

-- 1) RLS 有効化（ENABLE のみ）
ALTER TABLE news_items ENABLE ROW LEVEL SECURITY;

-- 2) news_items_read_all（FOR SELECT, USING (true)）= 全ロール + 匿名サイネージが読める
DROP POLICY IF EXISTS news_items_read_all ON news_items;
CREATE POLICY news_items_read_all ON news_items FOR SELECT
  USING (true);

-- 3) news_items_write_system（INSERT/UPDATE/DELETE は system_admin のみ）= 取得 Job だけが upsert
DROP POLICY IF EXISTS news_items_write_system_insert ON news_items;
CREATE POLICY news_items_write_system_insert ON news_items FOR INSERT
  WITH CHECK (current_setting('app.current_user_role', true) = 'system_admin');

DROP POLICY IF EXISTS news_items_write_system_update ON news_items;
CREATE POLICY news_items_write_system_update ON news_items FOR UPDATE
  USING (current_setting('app.current_user_role', true) = 'system_admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'system_admin');

DROP POLICY IF EXISTS news_items_write_system_delete ON news_items;
CREATE POLICY news_items_write_system_delete ON news_items FOR DELETE
  USING (current_setting('app.current_user_role', true) = 'system_admin');

-- 4) 監査 FK: created_by / updated_by → users(id) ON DELETE SET NULL（取得 Job の書き込みは null）
ALTER TABLE news_items DROP CONSTRAINT IF EXISTS news_items_created_by_users_fk;
ALTER TABLE news_items
  ADD CONSTRAINT news_items_created_by_users_fk
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE news_items DROP CONSTRAINT IF EXISTS news_items_updated_by_users_fk;
ALTER TABLE news_items
  ADD CONSTRAINT news_items_updated_by_users_fk
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL;
