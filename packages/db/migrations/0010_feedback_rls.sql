-- =====================================================================
-- 0010_feedback_rls.sql
-- 目的: F12 (#48-M) feedback テーブルの RLS を確定する。
--       (a) 閲覧は system_admin のみ (system_admin_only)、
--       (b) 非認証 (匿名) 投稿のための「RLS をくぐる唯一の細い扉」=
--           SECURITY DEFINER 関数 submit_feedback(...)。
--
-- 前提: drizzle/0010_feedback.sql で feedback テーブルが作成済であること。
--
-- =====================================================================
-- ★ 最重要 (Reviewer 重点): SELECT は絶対に匿名 / app ロールに開けない
-- =====================================================================
-- feedback は cross-tenant (CRM の advertisers / contracts と同系) で、school_id は
-- 投稿者の自己申告であってテナント分離キーではない。student_episode 等は PII を含みうる
-- (schema/feedback.ts ルール4 注記)。よって SELECT を school_id 一致や匿名に開けると、
-- 攻撃者が任意の school_id を app.current_school_id に張るだけで全校フィードバック (PII 含む)
-- を読めてしまう = サービス終了級の漏洩。SELECT は system_admin_only ポリシーで
-- **system_admin に限定**する (ADR-019 system_admin_only、CLAUDE.md ルール2)。
--
-- =====================================================================
-- 匿名 INSERT を SECURITY DEFINER に閉じ込める根拠 (ADR-019 §代替E との関係)
-- =====================================================================
-- guide フォームは非認証 = テナント context (app.current_school_id) も system_admin role も
-- 無い。この状態で feedback へ直接 INSERT すると system_admin_only の WITH CHECK を満たせず
-- 必ず拒否される (deny-by-default、正しい挙動)。一方 kimiterrace_app に INSERT 用の緩い policy
-- を足すと、その policy 経由で SELECT 面のリスクや横展開を招きやすい。
--
-- そこで resolve_magic_link (migrations/0008) と同じく、**INSERT だけ**を 1 本の SECURITY
-- DEFINER 関数 submit_feedback(...) に閉じ込める。所有者 (migration 実行ロール) は feedback に
-- FORCE ROW LEVEL SECURITY が無いため RLS をバイパスでき、関数経由の INSERT のみ成立する。
-- ADR-019 §代替E が却下したのは「cross-tenant **SELECT** を SECURITY DEFINER で実装する」案
-- (誤用でテナント越境 SELECT を生む) であり、本関数は SELECT を一切返さず INSERT 1 行に限定。
-- 引数で値を受け検証し、動的 SQL なし・search_path='' で injection を封じる。SELECT 面は
-- system_admin_only のまま不変なので、§代替E の懸念 (越境 SELECT) は構造的に発生しない。
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) RLS 有効化 (ENABLE のみ。FORCE はしない)
--    FORCE を付けると所有者にも policy が強制され、submit_feedback (SECURITY DEFINER)
--    の INSERT までブロックされる。magic_links / CRM と同じく ENABLE 止まりにし、
--    通常接続 (kimiterrace_app = 非所有者) は policy に従わせ、所有者の関数だけが扉になる。
-- ---------------------------------------------------------------------
ALTER TABLE feedback ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------
-- 2) system_admin_only policy (FOR ALL)
--    SELECT / INSERT / UPDATE / DELETE すべてを system_admin に限定する。
--    ADR-019 §Policy 命名規約「予約名」system_admin_only の初実装。
--    USING / WITH CHECK とも role = 'system_admin' のみ true。
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS system_admin_only ON feedback;
CREATE POLICY system_admin_only ON feedback FOR ALL
  USING (current_setting('app.current_user_role', true) = 'system_admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'system_admin');

-- ---------------------------------------------------------------------
-- 3) 監査 FK: created_by / updated_by → users(id) ON DELETE SET NULL
--    匿名投稿では NULL になる (投稿者特定はしない、schema docstring 参照)。
--    (src/_shared/audit.ts は循環依存回避で FK 未宣言。0006/0009 と同じ後付けパターン)
-- ---------------------------------------------------------------------
ALTER TABLE feedback DROP CONSTRAINT IF EXISTS feedback_created_by_users_fk;
ALTER TABLE feedback ADD CONSTRAINT feedback_created_by_users_fk
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE feedback DROP CONSTRAINT IF EXISTS feedback_updated_by_users_fk;
ALTER TABLE feedback ADD CONSTRAINT feedback_updated_by_users_fk
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------
-- 4) 匿名 INSERT の扉: submit_feedback(...) (SECURITY DEFINER)
--    * 所有者権限で 1 行だけ INSERT し、id を返す (SELECT 面は一切返さない)。
--    * SET search_path = '' + public.feedback への完全修飾で injection を封じる。
--    * 入力検証: student_reaction / teacher_utility は 1..5 を関数内でも検証
--      (CHECK 制約と二重防御)。範囲外は例外で倒す。
--    * created_by / updated_by は載せない (匿名投稿 = actor 不明、NULL)。
--    * VOLATILE (INSERT する)。STABLE/IMMUTABLE にはしない。
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION submit_feedback(
  p_school_name text,
  p_school_id uuid,
  p_classroom_label text,
  p_student_reaction integer,
  p_teacher_utility integer,
  p_student_episode text,
  p_improvement text
)
  RETURNS uuid
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_student_reaction IS NULL OR p_student_reaction < 1 OR p_student_reaction > 5 THEN
    RAISE EXCEPTION 'submit_feedback: student_reaction は 1-5 の整数である必要があります (got %)', p_student_reaction;
  END IF;
  IF p_teacher_utility IS NULL OR p_teacher_utility < 1 OR p_teacher_utility > 5 THEN
    RAISE EXCEPTION 'submit_feedback: teacher_utility は 1-5 の整数である必要があります (got %)', p_teacher_utility;
  END IF;

  INSERT INTO public.feedback (
    school_name, school_id, classroom_label,
    student_reaction, teacher_utility, student_episode, improvement
  )
  VALUES (
    NULLIF(p_school_name, ''), p_school_id, NULLIF(p_classroom_label, ''),
    p_student_reaction, p_teacher_utility, NULLIF(p_student_episode, ''), NULLIF(p_improvement, '')
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- 権限: PUBLIC からは EXECUTE を剥がし、kimiterrace_app にのみ付与する
-- (resolve_magic_link と同じ最小権限。匿名 guide route は kimiterrace_app 接続で呼ぶ)。
REVOKE ALL ON FUNCTION submit_feedback(text, uuid, text, integer, integer, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION submit_feedback(text, uuid, text, integer, integer, text, text) TO kimiterrace_app;
