-- =====================================================================
-- 0017_weather_forecasts_rls.sql
-- 目的: F14 (#128, ADR-021) で追加した天気予報キャッシュ weather_forecasts に
--       RLS（公開参照マスタの特例パターン）+ 監査 FK を付与する。
--
-- 前提: drizzle/20260602033423_f14_weather_forecasts.sql で weather_forecasts が作成済であること。
--
-- =====================================================================
-- ★ なぜ tenant_isolation ではないか（ADR-019 §公開参照マスタ特例 / F14 受け入れ条件 §1）
-- =====================================================================
-- weather_forecasts は **school_id を持たない cross-tenant 参照テーブル**。岐阜県の全校は同じ
-- 府県予報区コードの 1 行を共有する（地域 dedup）。データは **学校横断の公開・非 PII** な気象情報で、
-- 漏れても無害。したがって RLS は tenant_isolation（school_id 一致）ではなく:
--   (a) weather_read_all   … FOR SELECT, USING (true)   = 全ロール / 匿名サイネージも読める
--   (b) weather_write_system… INSERT/UPDATE/DELETE は system のみ = 取得 Job だけが書く
-- という二本立てにする。これは CRM (system_admin_only、読み書きとも system 限定) とは保護要件が
-- 異なる別枠であり、SELECT 全開放は「school_id 非保持 かつ 公開・非 PII の両方を満たすテーブル」に
-- のみ許される特例（ADR-019 適用ルール6）。
--
-- ★ Reviewer 重点: SELECT を USING (true) に開けてよいのは本テーブルが公開・非 PII であるため。
--   将来 PII を含む列を足す変更は本特例の前提を壊すので不可（その場合は ADR を改める）。
--
-- ★ サイネージ匿名読み取り（ADR-016）: サイネージ端末は role を SET せず school_id のみ（or 無し）の
--   deny-by-default 接続。weather_read_all は USING (true) なので role / school_id に依存せず読める。
--   §5 の RLS テストで「匿名コンテキストでも読める」ことを固定する。
--
-- ★ 書き込みの actor: 取得 Job は system context（app.current_user_role='system_admin'）で書く。
--   F14 受け入れ条件は将来のサービスロール system_service も許す想定だが、本スライスでは既存の
--   sensor-presence（#408）と同じ system_admin context 経路を再利用する（TenantRole union を変える
--   client.ts は他レーンの chokepoint のため非接触）。system_service の追加は follow-up。
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) RLS 有効化（ENABLE のみ。FORCE はしない = テーブル所有者/migrator はバイパス可）
-- ---------------------------------------------------------------------
ALTER TABLE weather_forecasts ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------
-- 2) weather_read_all policy（FOR SELECT, USING (true)）
--    全ロール（school_admin / teacher / student / guardian / system_admin）および匿名サイネージ
--    コンテキストが読める。天気は公開・非 PII の共有キャッシュ（ADR-021 §結果）。
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS weather_read_all ON weather_forecasts;
CREATE POLICY weather_read_all ON weather_forecasts FOR SELECT
  USING (true);

-- ---------------------------------------------------------------------
-- 3) weather_write_system policy（INSERT / UPDATE / DELETE は system_admin のみ）
--    取得 Job だけが system context で upsert する。app ロールの一般ユーザー・匿名は書けない。
--    FOR ALL ではなく書込み 3 コマンドを明示し、SELECT 面は weather_read_all のみに保つ
--    （FOR ALL にすると system_admin 用の重複 SELECT 述語が増え意図が読みにくくなるため）。
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS weather_write_system_insert ON weather_forecasts;
CREATE POLICY weather_write_system_insert ON weather_forecasts FOR INSERT
  WITH CHECK (current_setting('app.current_user_role', true) = 'system_admin');

DROP POLICY IF EXISTS weather_write_system_update ON weather_forecasts;
CREATE POLICY weather_write_system_update ON weather_forecasts FOR UPDATE
  USING (current_setting('app.current_user_role', true) = 'system_admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'system_admin');

DROP POLICY IF EXISTS weather_write_system_delete ON weather_forecasts;
CREATE POLICY weather_write_system_delete ON weather_forecasts FOR DELETE
  USING (current_setting('app.current_user_role', true) = 'system_admin');

-- ---------------------------------------------------------------------
-- 4) 監査 FK: created_by / updated_by → users(id) ON DELETE SET NULL
--    取得 Job の書き込みは null（システム = system://weather-fetch）。
--    （src/_shared/audit.ts は循環依存回避で FK 未宣言。0004/0006/0014 と同じ後付けパターン）
-- ---------------------------------------------------------------------
ALTER TABLE weather_forecasts DROP CONSTRAINT IF EXISTS weather_forecasts_created_by_users_fk;
ALTER TABLE weather_forecasts
  ADD CONSTRAINT weather_forecasts_created_by_users_fk
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE weather_forecasts DROP CONSTRAINT IF EXISTS weather_forecasts_updated_by_users_fk;
ALTER TABLE weather_forecasts
  ADD CONSTRAINT weather_forecasts_updated_by_users_fk
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL;
