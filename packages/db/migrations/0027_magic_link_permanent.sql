-- =====================================================================
-- 0027_magic_link_permanent.sql
-- 目的 (ADR-042 PR1 / DB 基盤):
--   サイネージ / 生徒 magic-link を「無期限・再表示可」にできるよう、
--   `magic_links.expires_at` の NOT NULL を外し、再表示用の平文トークン列
--   `token` を追加する。あわせて `resolve_magic_link()` を NULL=無期限を
--   解決できる定義に改修する。
--   ※ 発行 API は本 PR では NULL を書かない（挙動変更は PR2）。本 PR は
--     DB の nullability 基盤と resolve の改修のみ。既存の期限つきリンクは従来どおり。
--
-- 冪等性:
--   * `ALTER COLUMN ... DROP NOT NULL` は再適用安全（既に nullable なら no-op）。
--   * `ADD COLUMN IF NOT EXISTS` で token 列追加は再適用安全。
--   * `CREATE OR REPLACE FUNCTION` は再適用安全（同名・同シグネチャを上書き）。
--   * REVOKE/GRANT も再適用安全。
--
-- ⚠ resolve_magic_link は SECURITY DEFINER 関数で、**誤ると全 magic-link /
--   サイネージが静かに全断する最重要点**。本 migration の本番適用は人間ゲート
--   （migrator ロールで安全に・apply-migration runbook 参照。Claude は staging まで）。
--
-- loader 順序メモ:
--   __tests__/_setup/global-setup.ts の loader は drizzle/* → migrations/* を
--   ファイル名昇順で全件適用する。本 migration (0027) は既存の resolve 定義
--   (0012_f05_magic_link_resolve_fn.sql) より後に流れ、CREATE OR REPLACE で
--   上書きする（後勝ち）。改修点は `expires_at > now()` →
--   `expires_at IS NULL OR expires_at > now()` の 1 点のみ（NULL=無期限を解決）。
--
-- ADR-019 二層 RLS / CLAUDE.md ルール2 (RLS を DB レベルで強制) / ルール5
-- (token 平文を残さない方針は維持。token 列は PR2 の再表示要件のため列のみ追加) 準拠。
-- =====================================================================

ALTER TABLE magic_links ALTER COLUMN expires_at DROP NOT NULL;
ALTER TABLE magic_links ADD COLUMN IF NOT EXISTS token varchar(128);

CREATE OR REPLACE FUNCTION resolve_magic_link(p_token_hash text)
  RETURNS TABLE (id uuid, school_id uuid, class_id uuid)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = ''
AS $$
  SELECT ml.id, ml.school_id, ml.class_id
  FROM public.magic_links AS ml
  WHERE ml.token_hash = p_token_hash
    AND ml.class_id IS NOT NULL
    AND ml.revoked_at IS NULL
    AND (ml.expires_at IS NULL OR ml.expires_at > now())
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION resolve_magic_link(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_magic_link(text) TO kimiterrace_app;
