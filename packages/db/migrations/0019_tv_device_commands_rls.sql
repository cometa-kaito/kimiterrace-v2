-- =====================================================================
-- 0019_tv_device_commands_rls.sql
-- 目的: F15 (ADR-022) で追加した TV リモートコマンドキュー tv_device_commands に
--       RLS（テナント分離）+ 監査 FK + issued_by FK を付与する。
--
-- 前提: drizzle/20260602060632_married_killmonger.sql で tv_device_commands が
--       作成済であること（loader はファイル名昇順で drizzle/ → migrations/ を流す）。
--
-- 構成（既存 0016_tv_devices_rls.sql と同一パターン、対象 1 テーブル）:
--   1. ENABLE ROW LEVEL SECURITY
--   2. tenant_isolation policy（school_id 一致、FOR ALL、USING + WITH CHECK）
--   3. system_admin_full_access policy（role = 'system_admin'）
--   4. created_by / updated_by / issued_by → users(id) FK（ON DELETE SET NULL）
--
-- ADR-019 二層 RLS モデル / CLAUDE.md ルール1・2 準拠。
-- 注: 発行（管理 UI）は自校テナント context（system_admin はテナントスコープで school_admin に降格、
--     ADR-019 §#95 / Issue #226）で INSERT する。配信/ack（ポーリング経路、GET /api/tv/config /
--     POST /api/tv/commands/ack）はセッション無しのため、pollTvConfig / recordPresenceEvent（F13）と
--     同じく system_admin role context（system_admin_full_access policy 経由）で cross-tenant 解決し、
--     解決 school_id を pin して読み取り / status 遷移する（BYPASSRLS 不使用、ルール2）。device_id は
--     tv_devices 側でグローバル UNIQUE のため、コマンド行は当該 device の school にしか存在せず
--     テナント越境配信を構造的に防ぐ。
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) RLS 有効化
-- ---------------------------------------------------------------------
ALTER TABLE tv_device_commands ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------
-- 2) tenant_isolation policy
--    USING: 既存行が可視か / WITH CHECK: 新規行が許可されるか
--    NULLIF(..., '') は current_setting の missing_ok モードが空文字を返すケースの
--    fail-closed 対策（全 policy に適用済のパターン）。
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS tenant_isolation ON tv_device_commands;
CREATE POLICY tenant_isolation ON tv_device_commands FOR ALL
  USING (school_id = NULLIF(current_setting('app.current_school_id', true), '')::uuid)
  WITH CHECK (school_id = NULLIF(current_setting('app.current_school_id', true), '')::uuid);

-- ---------------------------------------------------------------------
-- 3) system_admin_full_access policy（cross-tenant、role = 'system_admin'）
--    ポーリング配信/ack は全校横断の解決を要するため system_admin が行う。
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS system_admin_full_access ON tv_device_commands;
CREATE POLICY system_admin_full_access ON tv_device_commands FOR ALL
  USING (current_setting('app.current_user_role', true) = 'system_admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'system_admin');

-- ---------------------------------------------------------------------
-- 4) 監査 FK + issued_by FK: created_by / updated_by / issued_by → users(id) ON DELETE SET NULL
--    （src/_shared/audit.ts は循環依存回避で FK 未宣言。0004/0006/0014/0016/0018 と同じ後付けパターン。
--     issued_by も発行者 users(id) への参照で、退職等で users が消えても履歴行は残す＝SET NULL）。
-- ---------------------------------------------------------------------
ALTER TABLE tv_device_commands DROP CONSTRAINT IF EXISTS tv_device_commands_created_by_users_fk;
ALTER TABLE tv_device_commands
  ADD CONSTRAINT tv_device_commands_created_by_users_fk
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE tv_device_commands DROP CONSTRAINT IF EXISTS tv_device_commands_updated_by_users_fk;
ALTER TABLE tv_device_commands
  ADD CONSTRAINT tv_device_commands_updated_by_users_fk
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE tv_device_commands DROP CONSTRAINT IF EXISTS tv_device_commands_issued_by_users_fk;
ALTER TABLE tv_device_commands
  ADD CONSTRAINT tv_device_commands_issued_by_users_fk
  FOREIGN KEY (issued_by) REFERENCES users(id) ON DELETE SET NULL;
