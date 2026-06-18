-- =====================================================================
-- 0031_signage_snippets_rls.sql
-- 目的: サイネージ静的コンテンツ（名言/四字熟語/英単語/今日は何の日）の共有マスタ
--       signage_snippets に RLS（公開参照マスタの特例パターン）+ 監査 FK を付与する。
--
-- 前提: drizzle 自動生成 migration（idx37, 20260618114429_smiling_norman_osborn）で signage_snippets
--       テーブル + snippet_category enum が作成済であること（手書き RLS の本ファイルは drizzle DDL
--       適用後・0030 heat_alerts の後に流す）。
--
-- =====================================================================
-- ★ なぜ tenant_isolation ではないか（ADR-019 §公開参照マスタ特例）
-- =====================================================================
-- signage_snippets は **school_id を持たない cross-tenant 参照テーブル**。名言・四字熟語・英単語・記念日は
-- 学校横断の公開・非 PII な一般教養データであり、全校が同じ静的コンテンツ集合を共有する（weather_warnings
-- 0029 / heat_alerts 0030 / news_items 0028 と同じ）。漏れても無害。したがって RLS は tenant_isolation
-- （school_id 一致）ではなく:
--   (a) signage_snippets_read_all    … FOR SELECT, USING (true)   = 全ロール / 匿名サイネージも読める
--   (b) signage_snippets_write_system… INSERT/UPDATE/DELETE は system のみ = seed / コンテンツ投入だけが書く
-- という二本立てにする。SELECT 全開放は「school_id 非保持 かつ 公開・非 PII の両方を満たすテーブル」にのみ
-- 許される特例（ADR-019 適用ルール6）。
--
-- ★ 完全ゼロコスト枠: weather/news 等と違い本テーブルは外部 API も Cloud Run Job も使わない。seed 済みの
--   静的データをサイネージ側が日付決定論ローテで読むだけ（取得 Job 無し = run.ts 不変）。
--
-- ★ Reviewer 重点: SELECT を USING (true) に開けてよいのは本テーブルが公開・非 PII であるため。
--   **将来 PII を含む列を足す変更は本特例の前提を壊すので不可**（その場合は ADR を改める）。本テーブルには
--   一般教養テキスト（名言/四字熟語/英単語/記念日）のみを格納し、生 PII を入れない。
--
-- ★ サイネージ匿名読み取り（ADR-016）: サイネージ端末は role を SET せず school_id のみ（or 無し）の
--   deny-by-default 接続。signage_snippets_read_all は USING (true) なので role / school_id に依存せず読める。
--   §5 の RLS テストで「匿名コンテキストでも読める」ことを固定する。
--
-- ★ 書き込みの actor: seed / コンテンツ投入は system context（app.current_user_role='system_admin'）で書く。
--   weather_warnings / heat_alerts と同じ system_admin context 経路を再利用する。
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) RLS 有効化（ENABLE のみ。FORCE はしない = テーブル所有者/migrator はバイパス可）
-- ---------------------------------------------------------------------
ALTER TABLE signage_snippets ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------
-- 2) signage_snippets_read_all policy（FOR SELECT, USING (true)）
--    全ロール（school_admin / teacher / student / guardian / system_admin）および匿名サイネージ
--    コンテキストが読める。静的コンテンツは公開・非 PII の共有マスタ。
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS signage_snippets_read_all ON signage_snippets;
CREATE POLICY signage_snippets_read_all ON signage_snippets FOR SELECT
  USING (true);

-- ---------------------------------------------------------------------
-- 3) signage_snippets_write_system policy（INSERT / UPDATE / DELETE は system_admin のみ）
--    seed / コンテンツ投入だけが system context で書く。app ロールの一般ユーザー・匿名は書けない。
--    FOR ALL ではなく書込み 3 コマンドを明示し、SELECT 面は signage_snippets_read_all のみに保つ。
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS signage_snippets_write_system_insert ON signage_snippets;
CREATE POLICY signage_snippets_write_system_insert ON signage_snippets FOR INSERT
  WITH CHECK (current_setting('app.current_user_role', true) = 'system_admin');

DROP POLICY IF EXISTS signage_snippets_write_system_update ON signage_snippets;
CREATE POLICY signage_snippets_write_system_update ON signage_snippets FOR UPDATE
  USING (current_setting('app.current_user_role', true) = 'system_admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'system_admin');

DROP POLICY IF EXISTS signage_snippets_write_system_delete ON signage_snippets;
CREATE POLICY signage_snippets_write_system_delete ON signage_snippets FOR DELETE
  USING (current_setting('app.current_user_role', true) = 'system_admin');

-- ---------------------------------------------------------------------
-- 4) 監査 FK: created_by / updated_by → users(id) ON DELETE SET NULL
--    seed / コンテンツ投入の書き込みは null（システム = system://signage-snippets-seed）。
--    （src/_shared/audit.ts は循環依存回避で FK 未宣言。0029（警報）/ 0030（熱中症）と同じ後付けパターン）
-- ---------------------------------------------------------------------
ALTER TABLE signage_snippets DROP CONSTRAINT IF EXISTS signage_snippets_created_by_users_fk;
ALTER TABLE signage_snippets
  ADD CONSTRAINT signage_snippets_created_by_users_fk
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE signage_snippets DROP CONSTRAINT IF EXISTS signage_snippets_updated_by_users_fk;
ALTER TABLE signage_snippets
  ADD CONSTRAINT signage_snippets_updated_by_users_fk
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL;
