-- =====================================================================
-- 0029_weather_warnings_rls.sql
-- 目的: ADR-044 で追加した気象警報・注意報キャッシュ weather_warnings に
--       RLS（公開参照マスタの特例パターン）+ 監査 FK を付与する。
--
-- 前提: drizzle 自動生成 migration（idx35）で weather_warnings テーブル + warning_level enum が
--       作成済であること（手書き RLS の本ファイルは drizzle DDL 適用後・0028 news_items の後に流す）。
--
-- =====================================================================
-- ★ なぜ tenant_isolation ではないか（ADR-019 §公開参照マスタ特例 / ADR-044 §決定 4）
-- =====================================================================
-- weather_warnings は **school_id を持たない cross-tenant 参照テーブル**。岐阜県の全校は同じ府県予報区
-- コードの 1 行を共有する（地域 dedup）。データは **学校横断の公開・非 PII** な気象警報情報（誰でも JMA から
-- 取得できる）であり、漏れても無害。したがって RLS は tenant_isolation（school_id 一致）ではなく:
--   (a) weather_warnings_read_all    … FOR SELECT, USING (true)   = 全ロール / 匿名サイネージも読める
--   (b) weather_warnings_write_system… INSERT/UPDATE/DELETE は system のみ = 取得 Job だけが書く
-- という二本立てにする（weather_forecasts 0017 / railway_status 0025 と同じ）。SELECT 全開放は
-- 「school_id 非保持 かつ 公開・非 PII の両方を満たすテーブル」にのみ許される特例（ADR-019 適用ルール6）。
--
-- ★ Reviewer 重点: SELECT を USING (true) に開けてよいのは本テーブルが公開・非 PII であるため。
--   **将来 PII を含む列を足す変更は本特例の前提を壊すので不可**（その場合は ADR を改める）。本テーブルには
--   地域コード・警報コード/名称・ヘッドライン本文・原文 JSON のみを格納し、生 PII を入れない。
--
-- ★ サイネージ匿名読み取り（ADR-016）: サイネージ端末は role を SET せず school_id のみ（or 無し）の
--   deny-by-default 接続。weather_warnings_read_all は USING (true) なので role / school_id に依存せず読める。
--   §5 の RLS テストで「匿名コンテキストでも読める」ことを固定する。
--
-- ★ 書き込みの actor: 取得 Job（既存の天気 Job に相乗り、ADR-044 §決定 1）は system context
--   （app.current_user_role='system_admin'）で書く。weather_forecasts と同じ system_admin context 経路を再利用する。
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) RLS 有効化（ENABLE のみ。FORCE はしない = テーブル所有者/migrator はバイパス可）
-- ---------------------------------------------------------------------
ALTER TABLE weather_warnings ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------
-- 2) weather_warnings_read_all policy（FOR SELECT, USING (true)）
--    全ロール（school_admin / teacher / student / guardian / system_admin）および匿名サイネージ
--    コンテキストが読める。警報は公開・非 PII の共有キャッシュ（ADR-044 §決定 4）。
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS weather_warnings_read_all ON weather_warnings;
CREATE POLICY weather_warnings_read_all ON weather_warnings FOR SELECT
  USING (true);

-- ---------------------------------------------------------------------
-- 3) weather_warnings_write_system policy（INSERT / UPDATE / DELETE は system_admin のみ）
--    取得 Job だけが system context で upsert する。app ロールの一般ユーザー・匿名は書けない。
--    FOR ALL ではなく書込み 3 コマンドを明示し、SELECT 面は weather_warnings_read_all のみに保つ。
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS weather_warnings_write_system_insert ON weather_warnings;
CREATE POLICY weather_warnings_write_system_insert ON weather_warnings FOR INSERT
  WITH CHECK (current_setting('app.current_user_role', true) = 'system_admin');

DROP POLICY IF EXISTS weather_warnings_write_system_update ON weather_warnings;
CREATE POLICY weather_warnings_write_system_update ON weather_warnings FOR UPDATE
  USING (current_setting('app.current_user_role', true) = 'system_admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'system_admin');

DROP POLICY IF EXISTS weather_warnings_write_system_delete ON weather_warnings;
CREATE POLICY weather_warnings_write_system_delete ON weather_warnings FOR DELETE
  USING (current_setting('app.current_user_role', true) = 'system_admin');

-- ---------------------------------------------------------------------
-- 4) 監査 FK: created_by / updated_by → users(id) ON DELETE SET NULL
--    取得 Job の書き込みは null（システム = system://weather-fetch）。
--    （src/_shared/audit.ts は循環依存回避で FK 未宣言。0017（天気）と同じ後付けパターン）
-- ---------------------------------------------------------------------
ALTER TABLE weather_warnings DROP CONSTRAINT IF EXISTS weather_warnings_created_by_users_fk;
ALTER TABLE weather_warnings
  ADD CONSTRAINT weather_warnings_created_by_users_fk
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE weather_warnings DROP CONSTRAINT IF EXISTS weather_warnings_updated_by_users_fk;
ALTER TABLE weather_warnings
  ADD CONSTRAINT weather_warnings_updated_by_users_fk
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL;
