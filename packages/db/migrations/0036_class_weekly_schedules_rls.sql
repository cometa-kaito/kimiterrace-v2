-- =====================================================================
-- 0036_class_weekly_schedules_rls.sql
-- 目的: F5 週次ベース時間割の per-class テーブル class_weekly_schedules に
--       RLS（テナント分離）+ 監査 FK を付与する。
--
-- 前提: drizzle 自動生成 migration（class_weekly_schedules の DDL）で
--       テーブルが作成済であること（手書き RLS の本ファイルは drizzle DDL 適用後に流す）。
--
-- 番号について: 旧作業ブランチでは 0034 だったが、main で 0034_class_visitors_sort_order /
-- 0035_student_callouts_sort_order が使用済のため 0036 へ振り直した（採番衝突の回避）。
--
-- 構成（既存 0023_class_visitors_rls.sql / 0032_school_calendar_rls.sql と同一パターン）:
--   1. ENABLE ROW LEVEL SECURITY
--   2. tenant_isolation policy（school_id 一致、FOR ALL、USING + WITH CHECK）
--   3. system_admin_full_access policy（role = 'system_admin'、/ops 経路・全校横断管理用）
--   4. created_by / updated_by → users(id) FK（ON DELETE SET NULL）
--
-- ADR-019 二層 RLS モデル / CLAUDE.md ルール1・2 準拠。
-- =====================================================================
-- ★ なぜ tenant_isolation か（daily_data / class_visitors と同じ）
--   基本時間割は **クラス固有の学校内データ**（そのクラスの月〜金の科目）であり、weather 系のような公開共有
--   キャッシュではない。よって RLS は school_id 一致の tenant_isolation を採る。編集（school_admin / teacher）は
--   自校コンテキストで自校クラスのテンプレのみ読み書きでき、他校は不可視（school_id 不一致で 0 行、ルール2）。
--   サイネージ表示経路は本テーブルを読まない（コピーオンライトで daily_data のみ表示・設計書 §3 F5）。
-- =====================================================================

-- 1) RLS 有効化
ALTER TABLE class_weekly_schedules ENABLE ROW LEVEL SECURITY;

-- 2) tenant_isolation policy
--    USING: 既存行が可視か / WITH CHECK: 新規・更新行が許可されるか。
--    NULLIF(..., '') は current_setting の missing_ok（true）が空文字を返すケースの fail-closed 対策。
DROP POLICY IF EXISTS tenant_isolation ON class_weekly_schedules;
CREATE POLICY tenant_isolation ON class_weekly_schedules FOR ALL
  USING (school_id = NULLIF(current_setting('app.current_school_id', true), '')::uuid)
  WITH CHECK (school_id = NULLIF(current_setting('app.current_school_id', true), '')::uuid);

-- 3) system_admin_full_access policy（cross-tenant、role = 'system_admin'）
--    /ops 経路の他校クラス編集・全校横断管理用（BYPASSRLS は使わない・ADR-019）。
DROP POLICY IF EXISTS system_admin_full_access ON class_weekly_schedules;
CREATE POLICY system_admin_full_access ON class_weekly_schedules FOR ALL
  USING (current_setting('app.current_user_role', true) = 'system_admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'system_admin');

-- 4) 監査 FK: created_by / updated_by → users(id) ON DELETE SET NULL
--    （src/_shared/audit.ts は循環依存回避で FK 未宣言。class_visitors/0023 と同じ後付けパターン）
ALTER TABLE class_weekly_schedules DROP CONSTRAINT IF EXISTS class_weekly_schedules_created_by_users_fk;
ALTER TABLE class_weekly_schedules
  ADD CONSTRAINT class_weekly_schedules_created_by_users_fk
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE class_weekly_schedules DROP CONSTRAINT IF EXISTS class_weekly_schedules_updated_by_users_fk;
ALTER TABLE class_weekly_schedules
  ADD CONSTRAINT class_weekly_schedules_updated_by_users_fk
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL;
