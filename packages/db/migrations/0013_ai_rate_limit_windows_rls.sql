-- =====================================================================
-- 0013_ai_rate_limit_windows_rls.sql
-- 目的: F03 分散レート制限 (ADR-027, Issue #347) で追加した
--       ai_rate_limit_windows に RLS + 監査 FK を付与する。
--
-- 対象テーブル (school_id を持つテナント分離テーブル):
--   ai_rate_limit_windows
--
-- 前提: drizzle/20260601035906_ai_rate_limit_windows.sql で
--       テーブル本体が作成済であること。
--
-- 構成:
--   1. ENABLE ROW LEVEL SECURITY + FORCE (テーブル所有者でも RLS 適用)
--   2. tenant_isolation policy (school_id 一致、FOR ALL、USING + WITH CHECK)
--   3. created_by / updated_by → users(id) FK (ON DELETE SET NULL)
--
-- 設計メモ:
--   - system_admin_full_access policy は **付与しない**。本テーブルは
--     レート集計の中間データで、cross-tenant 可視性の業務要件が無い。
--     運用クリンナップ (古い window 行の削除) は migrator/cron が
--     BYPASSRLS で実行する想定 (ADR-027 §運用 / packages/db/src/schema/ai-rate-limit-windows.ts)。
--   - INSERT ... ON CONFLICT DO UPDATE は USING/WITH CHECK の両方で
--     school_id 一致を要求する。FOR ALL の policy 1 つで網羅できる。
--
-- ADR-019 二層 RLS モデル (今回は system_admin 層なし) / CLAUDE.md ルール1・2 準拠。
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) RLS 有効化
-- ---------------------------------------------------------------------
ALTER TABLE ai_rate_limit_windows ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_rate_limit_windows FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------
-- 2) tenant_isolation policy
--    USING: 既存行が可視か / WITH CHECK: 新規行が許可されるか
--    NULLIF(..., '') は current_setting の missing_ok モードが空文字を返す
--    ケースの fail-closed 対策 (既存 policy 全体に適用済のパターン)。
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS tenant_isolation ON ai_rate_limit_windows;
CREATE POLICY tenant_isolation ON ai_rate_limit_windows FOR ALL
  USING (school_id = NULLIF(current_setting('app.current_school_id', true), '')::uuid)
  WITH CHECK (school_id = NULLIF(current_setting('app.current_school_id', true), '')::uuid);

-- ---------------------------------------------------------------------
-- 3) 監査 FK: created_by / updated_by → users(id) ON DELETE SET NULL
--    (src/_shared/audit.ts は循環依存回避で FK 未宣言。0004/0006/0009 と同じ後付けパターン)
-- ---------------------------------------------------------------------
ALTER TABLE ai_rate_limit_windows
  DROP CONSTRAINT IF EXISTS ai_rate_limit_windows_created_by_users_fk;
ALTER TABLE ai_rate_limit_windows
  ADD CONSTRAINT ai_rate_limit_windows_created_by_users_fk
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE ai_rate_limit_windows
  DROP CONSTRAINT IF EXISTS ai_rate_limit_windows_updated_by_users_fk;
ALTER TABLE ai_rate_limit_windows
  ADD CONSTRAINT ai_rate_limit_windows_updated_by_users_fk
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL;
