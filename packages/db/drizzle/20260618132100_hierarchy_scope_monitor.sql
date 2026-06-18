-- Phase5: hierarchy_scope に 'monitor' を追加（個別モニタ直指定・運営整理 G）。
--
-- ★ 単独ファイルに分離する理由: PostgreSQL は「ALTER TYPE ... ADD VALUE で追加した enum 値を、同一
--   トランザクション内で使用する」ことを禁じる（unsafe use of new value）。後続マイグレーション
--   20260618132105_ad_target_monitors.sql は ck_ads_scope の CHECK で 'monitor' を参照するため、
--   ADD VALUE はそれより前のファイルで**別トランザクションとして commit** しておく必要がある
--   （migrate-runner は非 CONCURRENTLY ファイルを 1 ファイル=1 トランザクションで適用する）。
-- 冪等: IF NOT EXISTS。
ALTER TYPE "public"."hierarchy_scope" ADD VALUE IF NOT EXISTS 'monitor';
