-- =====================================================================
-- 0018_tv_device_downtime_rls.sql
-- 目的: F16 (ADR-023) で追加した TV ダウンタイム記録 tv_device_downtime に
--       RLS（テナント分離）+ 監査 FK を付与する。
--
-- 前提: drizzle/20260602041304_f16_tv_device_downtime.sql で tv_device_downtime が
--       作成済であること（loader はファイル名昇順で drizzle/ → migrations/ を流す）。
--
-- 構成（既存 0016_tv_devices_rls.sql と同一パターン、対象 1 テーブル）:
--   1. ENABLE ROW LEVEL SECURITY
--   2. tenant_isolation policy（school_id 一致、FOR ALL、USING + WITH CHECK）
--   3. system_admin_full_access policy（role = 'system_admin'）
--   4. created_by / updated_by → users(id) FK（ON DELETE SET NULL）
--
-- ADR-019 二層 RLS モデル / CLAUDE.md ルール1・2 準拠。
-- 注: 定期チェッカ（apps/jobs 死活ジョブ + packages/db の runTvLivenessCheck）は全校横断で走るため
--     system_admin role context（system_admin_full_access policy 経由、BYPASSRLS 不使用、ルール2）で
--     INSERT/UPDATE し、down 判定した TV の school_id を pin する。school_admin は自校のダウン履歴のみ
--     閲覧できる（管理 UI の稼働率・履歴表示、F16 §5）。
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) RLS 有効化
-- ---------------------------------------------------------------------
ALTER TABLE tv_device_downtime ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------
-- 2) tenant_isolation policy
--    USING: 既存行が可視か / WITH CHECK: 新規行が許可されるか
--    NULLIF(..., '') は current_setting の missing_ok モードが空文字を返すケースの
--    fail-closed 対策（全 policy に適用済のパターン）。
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS tenant_isolation ON tv_device_downtime;
CREATE POLICY tenant_isolation ON tv_device_downtime FOR ALL
  USING (school_id = NULLIF(current_setting('app.current_school_id', true), '')::uuid)
  WITH CHECK (school_id = NULLIF(current_setting('app.current_school_id', true), '')::uuid);

-- ---------------------------------------------------------------------
-- 3) system_admin_full_access policy（cross-tenant、role = 'system_admin'）
--    定期チェッカは全校横断で down/recover を走査・記録するため system_admin が行う。
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS system_admin_full_access ON tv_device_downtime;
CREATE POLICY system_admin_full_access ON tv_device_downtime FOR ALL
  USING (current_setting('app.current_user_role', true) = 'system_admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'system_admin');

-- ---------------------------------------------------------------------
-- 4) 監査 FK: created_by / updated_by → users(id) ON DELETE SET NULL
--    チェッカ書き込みは null（システム = system://tv-health-check）。
--    （src/_shared/audit.ts は循環依存回避で FK 未宣言。0004/0006/0014/0016 と同じ後付けパターン）
-- ---------------------------------------------------------------------
ALTER TABLE tv_device_downtime DROP CONSTRAINT IF EXISTS tv_device_downtime_created_by_users_fk;
ALTER TABLE tv_device_downtime
  ADD CONSTRAINT tv_device_downtime_created_by_users_fk
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE tv_device_downtime DROP CONSTRAINT IF EXISTS tv_device_downtime_updated_by_users_fk;
ALTER TABLE tv_device_downtime
  ADD CONSTRAINT tv_device_downtime_updated_by_users_fk
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL;
