-- 役割
-- 本マイグレーションは以下の DB ロールを作成する:
--   app_user    : Cloud Run / アプリ接続用。BYPASSRLS なし → RLS が必ず効く
--   app_migrator: drizzle-kit migrate / 運用 DDL 用。BYPASSRLS あり
--
-- 注意:
--   - ADR-019 / CLAUDE.md ルール 2:
--     「BYPASSRLS を持つロールは migration 用以外作らない」
--   - dev / test 環境では `postgres` superuser が migration を流すが、
--     アプリ接続も `postgres` を使う運用にすると BYPASSRLS が常時効いて RLS テストが無意味になる。
--     よって RLS テスト時は明示的に `SET ROLE app_user` を使う（__tests__/_helpers/postgres.ts 参照）。
--
-- 関連: ADR-019, CLAUDE.md ルール 2

-- 既存ロールがあれば作り直さない（冪等）
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN;
  END IF;
END $$;
--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_migrator') THEN
    CREATE ROLE app_migrator NOLOGIN BYPASSRLS;
  END IF;
END $$;
--> statement-breakpoint

-- アプリロールが各テーブルを読み書きできるよう DML 権限を付与（SELECT/INSERT/UPDATE/DELETE）。
-- RLS policy 側で row レベルの可視性を絞る。
GRANT USAGE ON SCHEMA public TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
--> statement-breakpoint

-- 後続テーブルに対しても自動で同じ権限が付くようデフォルト権限を設定
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_user;
--> statement-breakpoint

-- audit_log は append-only。UPDATE / DELETE は文字通り拒否（trigger と二段構え）。
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "audit_log" FROM app_user;
--> statement-breakpoint

-- migrator はテーブル所有者扱い（既存マイグレーション接続が postgres なので所有者はそのまま、
-- ここでは BYPASSRLS 付き rollback/maintenance 用途のために最小権限のみ付与）
GRANT USAGE ON SCHEMA public TO app_migrator;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public TO app_migrator;
