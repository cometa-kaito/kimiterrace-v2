-- =====================================================================
-- 0012_f05_magic_link_resolve_fn.sql (旧 0008、loader auto-discovery のリナンバ)
-- 目的: F05 クラス magic link の「生徒匿名アクセス」のための token 解決を、
--       RLS をくぐる唯一の細い扉 (SECURITY DEFINER 関数) に閉じ込める。
--
-- 文脈 (Reviewer 重点確認ポイント):
--   生徒は school_id を未確定のまま `/s/{token}` に到達する。token → school_id の
--   解決はテナントコンテキスト確立より前なので、通常の RLS (tenant_isolation,
--   app.current_school_id 前提) ではそもそも引けない。かといって kimiterrace_app に
--   BYPASSRLS を与えるのは「DB レベルでテナント分離を強制」(CLAUDE.md ルール2) に反する。
--
-- 設計:
--   * SECURITY DEFINER 関数 `resolve_magic_link(token_hash)` を 1 本だけ用意する。
--     所有者 (= migration 実行ロール、prod は migrator / CI は superuser) は magic_links に
--     FORCE ROW LEVEL SECURITY が無い (0001_enable_rls.sql は ENABLE のみ) ため RLS を
--     バイパスできる。実行時はこの所有者権限で走る = テナント横断で 1 行だけ引ける。
--   * ただし返すのは **有効な行のみ** (revoked_at IS NULL かつ expires_at > now())、
--     かつ **クラスリンクのみ** (class_id IS NOT NULL。旧・保護者単回リンクはこの扉から
--     解決させない)。返却列も id / school_id / class_id の 3 つに絞り、token_hash や
--     監査カラムは漏らさない。token 保持者が当然知ってよい最小情報のみ。
--   * 失効・期限切れは 0 行で返す → 呼び出し側 (F05 student route) が 410 Gone を返す。
--   * SQL injection 対策: SET search_path = '' で空にし、参照は public.magic_links に
--     スキーマ修飾する (now() は pg_catalog で常に解決可能)。引数は本体内で値として
--     しか使わない (動的 SQL なし)。
--   * STABLE: 同一トランザクション内で副作用なし・now() は tx 内安定。
--
-- 権限: PUBLIC からは EXECUTE を剥がし、kimiterrace_app にのみ付与する。
--
-- ADR-019 二層 RLS / CLAUDE.md ルール2 (RLS を DB レベルで強制)・ルール5 (token 平文を
-- 残さない) 準拠。前提: drizzle/0003_f05_magic_link_class.sql で class_id / revoked_at 追加済。
-- =====================================================================

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
    AND ml.expires_at > now()
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION resolve_magic_link(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_magic_link(text) TO kimiterrace_app;
