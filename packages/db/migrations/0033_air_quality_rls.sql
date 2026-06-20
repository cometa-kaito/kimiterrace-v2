-- =====================================================================
-- 0033_air_quality_rls.sql
-- 目的: ADR-046 で追加した大気質(PM2.5)/UV指数 キャッシュ air_quality_index に
--       RLS（公開参照マスタの特例パターン）+ 監査 FK を付与する。
--
-- 前提: drizzle 自動生成 migration（idx39, 20260618132654_air_quality_index）で air_quality_index テーブル +
--       air_quality_source enum が作成済であること（手書き RLS の本ファイルは drizzle DDL 適用後・0032
--       school_calendar の後に流す）。
--
-- =====================================================================
-- ★ なぜ tenant_isolation ではないか（ADR-019 §公開参照マスタ特例 / ADR-044 §決定 4・ADR-046）
-- =====================================================================
-- air_quality_index は **school_id を持たない cross-tenant 参照テーブル**。岐阜県の全校は同じ地域コードの
-- 1 行（1 日 1 行）を共有する（地域 dedup）。データは **学校横断の公開・非 PII** な大気汚染 / 紫外線情報
-- （誰でも環境省そらまめくん・気象庁から取得できる）であり、漏れても無害。したがって RLS は tenant_isolation
-- （school_id 一致）ではなく:
--   (a) air_quality_index_read_all    … FOR SELECT, USING (true)   = 全ロール / 匿名サイネージも読める
--   (b) air_quality_index_write_system… INSERT/UPDATE/DELETE は system のみ = 取得 Job だけが書く
-- という二本立てにする（weather_forecasts 0017 / weather_warnings 0029 / heat_alerts 0030 / railway_status 0025 と同じ）。
-- SELECT 全開放は「school_id 非保持 かつ 公開・非 PII の両方を満たすテーブル」にのみ許される特例
-- （ADR-019 適用ルール6）。
--
-- ★ Reviewer 重点: SELECT を USING (true) に開けてよいのは本テーブルが公開・非 PII であるため。
--   **将来 PII を含む列を足す変更は本特例の前提を壊すので不可**（その場合は ADR を改める）。本テーブルには
--   地域コード・名称・大気/紫外線の数値・原文（正規化済の代表値）のみを格納し、生 PII を入れない。
--
-- ★ ソースの脆さ（ADR-046 §残存リスク①）: 主ソース「そらまめくん」は正規 JSON API 契約が確認できない JS SPA
--   （実質スクレイプ相当・非公式無保証）。取得 Job のパーサが完全防御的（欠落/形式変化は null・throw しない）で、
--   取得できない指標は null・原文は raw に保全する。RLS の公開型は天気系と同一なので本ファイルは天気系の雛形踏襲。
--
-- ★ サイネージ匿名読み取り（ADR-016）: サイネージ端末は role を SET せず school_id のみ（or 無し）の
--   deny-by-default 接続。air_quality_index_read_all は USING (true) なので role / school_id に依存せず読める。
--   §5 の RLS テストで「匿名コンテキストでも読める」ことを固定する。
--
-- ★ 書き込みの actor: 取得 Job（既存の天気 Job に相乗り、ADR-044 §決定 1）は system context
--   （app.current_user_role='system_admin'）で書く。weather_forecasts / weather_warnings / heat_alerts と同じ
--   system_admin context 経路を再利用する。
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) RLS 有効化（ENABLE のみ。FORCE はしない = テーブル所有者/migrator はバイパス可）
-- ---------------------------------------------------------------------
ALTER TABLE air_quality_index ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------
-- 2) air_quality_index_read_all policy（FOR SELECT, USING (true)）
--    全ロール（school_admin / teacher / student / guardian / system_admin）および匿名サイネージ
--    コンテキストが読める。大気質・UV は公開・非 PII の共有キャッシュ（ADR-044 §決定 4 / ADR-046）。
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS air_quality_index_read_all ON air_quality_index;
CREATE POLICY air_quality_index_read_all ON air_quality_index FOR SELECT
  USING (true);

-- ---------------------------------------------------------------------
-- 3) air_quality_index_write_system policy（INSERT / UPDATE / DELETE は system_admin のみ）
--    取得 Job だけが system context で upsert する。app ロールの一般ユーザー・匿名は書けない。
--    FOR ALL ではなく書込み 3 コマンドを明示し、SELECT 面は air_quality_index_read_all のみに保つ。
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS air_quality_index_write_system_insert ON air_quality_index;
CREATE POLICY air_quality_index_write_system_insert ON air_quality_index FOR INSERT
  WITH CHECK (current_setting('app.current_user_role', true) = 'system_admin');

DROP POLICY IF EXISTS air_quality_index_write_system_update ON air_quality_index;
CREATE POLICY air_quality_index_write_system_update ON air_quality_index FOR UPDATE
  USING (current_setting('app.current_user_role', true) = 'system_admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'system_admin');

DROP POLICY IF EXISTS air_quality_index_write_system_delete ON air_quality_index;
CREATE POLICY air_quality_index_write_system_delete ON air_quality_index FOR DELETE
  USING (current_setting('app.current_user_role', true) = 'system_admin');

-- ---------------------------------------------------------------------
-- 4) 監査 FK: created_by / updated_by → users(id) ON DELETE SET NULL
--    取得 Job の書き込みは null（システム = system://weather-fetch）。
--    （src/_shared/audit.ts は循環依存回避で FK 未宣言。0017（天気）/ 0029（警報）/ 0030（熱中症）と同じ後付けパターン）
-- ---------------------------------------------------------------------
ALTER TABLE air_quality_index DROP CONSTRAINT IF EXISTS air_quality_index_created_by_users_fk;
ALTER TABLE air_quality_index
  ADD CONSTRAINT air_quality_index_created_by_users_fk
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE air_quality_index DROP CONSTRAINT IF EXISTS air_quality_index_updated_by_users_fk;
ALTER TABLE air_quality_index
  ADD CONSTRAINT air_quality_index_updated_by_users_fk
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL;
