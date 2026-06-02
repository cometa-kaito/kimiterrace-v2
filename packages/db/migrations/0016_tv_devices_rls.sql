-- =====================================================================
-- 0016_tv_devices_rls.sql
-- 目的: F15/F16 (ADR-022/ADR-023) で追加した TV デバイスレジストリ tv_devices に
--       RLS（テナント分離）+ 監査 FK を付与する。
--
-- 前提: drizzle/20260602024915_f15_tv_devices.sql で tv_devices が作成済であること。
--
-- 構成（既存 0014_sensor_devices_rls.sql と同一パターン、対象 1 テーブル）:
--   1. ENABLE ROW LEVEL SECURITY
--   2. tenant_isolation policy（school_id 一致、FOR ALL、USING + WITH CHECK）
--   3. system_admin_full_access policy（role = 'system_admin'）
--   4. created_by / updated_by → users(id) FK（ON DELETE SET NULL）
--
-- ADR-019 二層 RLS モデル / CLAUDE.md ルール1・2 準拠。
-- 注: device_id のグローバル UNIQUE（ux_tv_devices_device_id, drizzle 側）は
--     ポーリングの device_id→school_id 一意解決のための制約（schema コメント参照）。
--     RLS とは独立に効く（UNIQUE 違反はテナント context に関わらず DB レベルで発生）。
--     ポーリング経路（GET /api/tv/config）はセッション無しのため、recordPresenceEvent（F13）と
--     同じく system_admin role context で cross-tenant 解決し、解決 school_id を pin して
--     last_seen_at を更新する（system_admin_full_access policy 経由、BYPASSRLS 不使用、ルール2）。
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) RLS 有効化
-- ---------------------------------------------------------------------
ALTER TABLE tv_devices ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------
-- 2) tenant_isolation policy
--    USING: 既存行が可視か / WITH CHECK: 新規行が許可されるか
--    NULLIF(..., '') は current_setting の missing_ok モードが空文字を返すケースの
--    fail-closed 対策（全 policy に適用済のパターン）。
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS tenant_isolation ON tv_devices;
CREATE POLICY tenant_isolation ON tv_devices FOR ALL
  USING (school_id = NULLIF(current_setting('app.current_school_id', true), '')::uuid)
  WITH CHECK (school_id = NULLIF(current_setting('app.current_school_id', true), '')::uuid);

-- ---------------------------------------------------------------------
-- 3) system_admin_full_access policy（cross-tenant、role = 'system_admin'）
--    デバイス登録・全校横断の管理・ポーリング解決は system_admin が行う想定。
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS system_admin_full_access ON tv_devices;
CREATE POLICY system_admin_full_access ON tv_devices FOR ALL
  USING (current_setting('app.current_user_role', true) = 'system_admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'system_admin');

-- ---------------------------------------------------------------------
-- 4) 監査 FK: created_by / updated_by → users(id) ON DELETE SET NULL
--    （src/_shared/audit.ts は循環依存回避で FK 未宣言。0004/0006/0014 と同じ後付けパターン）
-- ---------------------------------------------------------------------
ALTER TABLE tv_devices DROP CONSTRAINT IF EXISTS tv_devices_created_by_users_fk;
ALTER TABLE tv_devices
  ADD CONSTRAINT tv_devices_created_by_users_fk
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE tv_devices DROP CONSTRAINT IF EXISTS tv_devices_updated_by_users_fk;
ALTER TABLE tv_devices
  ADD CONSTRAINT tv_devices_updated_by_users_fk
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL;
