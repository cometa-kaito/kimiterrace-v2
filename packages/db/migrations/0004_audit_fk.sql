-- =====================================================================
-- 0004_audit_fk.sql
-- 目的: 全 18 テーブルの created_by / updated_by に users(id) FK を追加。
--
-- 背景: src/_shared/audit.ts は users との循環依存を避けるため Drizzle 側で
-- FK を付けず uuid 列のみ宣言している。物理 FK は「migration で ALTER TABLE で
-- 追加する」とコメントで明示済。本ファイルがその実体。
--
-- ON DELETE 動作: SET NULL
--   - audit 記録 (created_by / updated_by) は users 削除後も残す責任あり (NFR04)
--   - users.id を物理削除する経路は本来想定していないが、テスト fixture 等で
--     truncate / drop が走るケースに備え SET NULL でクラッシュを防ぐ
--
-- users 自身の created_by / updated_by は self-FK となる (循環参照だが ALTER で後付け可能)。
-- =====================================================================

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    -- テナント分離テーブル (12)
    'users', 'classes', 'memberships', 'magic_links',
    'contents', 'content_versions', 'publishes', 'events',
    'ai_extractions', 'ai_chat_sessions', 'ai_chat_messages',
    'monthly_reports',
    -- CRM / cross-tenant テーブル (5)
    'schools', 'advertisers', 'contracts', 'communications', 'system_admins',
    -- 監査台帳本体 (1)
    'audit_log'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    -- created_by
    EXECUTE format(
      'ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I',
      t, t || '_created_by_users_fk'
    );
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL',
      t, t || '_created_by_users_fk'
    );

    -- updated_by
    EXECUTE format(
      'ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I',
      t, t || '_updated_by_users_fk'
    );
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL',
      t, t || '_updated_by_users_fk'
    );
  END LOOP;
END
$$;
