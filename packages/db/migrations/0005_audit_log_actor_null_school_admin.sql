-- Issue #105 (PR #103 Reviewer Medium 1 follow-up):
-- audit_log_insert: school_admin / teacher など **テナント内ロール** が
-- actor_user_id = NULL の監査ログを差し込めないように policy を厳格化する。
--
-- 旧 (PR #103 で導入) policy では `actor_user_id IS NULL` を一般許容していた。
-- これは「内部システム / cross-tenant 操作」を意図したものだったが、
-- 乗っ取られた school_admin が actor_user_id = NULL で監査ログを書けば、
-- 攻撃者は自分の操作痕跡を匿名化できる (NFR04 Repudiation 攻撃)。
--
-- 新 policy では以下の場合のみ INSERT 可:
--   1. system_admin context: actor_user_id は NULL / 任意 uuid どちらも可
--      (cross-tenant 内部システム操作、月次集計、migrator 経由 INSERT を許容)
--   2. その他のロール (school_admin / teacher / system_service / ...):
--      actor_user_id は SET LOCAL された自分の user_id に **完全一致** のみ可
--      → NULL は SQL 評価で `NULL = uuid` が NULL (≠ true) となり拒否
--
-- school_id 側の policy はそのまま (cross-tenant / 自テナント / system_admin)。
--
-- 関連: Issue #105, NFR04 (監査ログの法的証拠力), ADR-019 (RLS 二層 + policy 規約)
--
-- 検証: __tests__/rls/audit-log-actor-spoofing.test.ts 4 ケース
--   - school_admin が自分自身 actor → 成功 (既存)
--   - school_admin が他ユーザー詐称 → 拒否 (既存)
--   - system_admin が任意 uuid actor → 成功 (既存)
--   - school_admin が NULL actor → **拒否** (本 migration で挙動変更、本 PR で追加)
--   - system_admin が NULL actor → 成功 (本 PR で追加、cross-tenant 内部操作)

DROP POLICY IF EXISTS audit_log_insert ON audit_log;

CREATE POLICY audit_log_insert ON audit_log FOR INSERT
  WITH CHECK (
    (
      -- school_id 側: cross-tenant (NULL) / 現テナント一致 / system_admin
      school_id IS NULL
      OR school_id = NULLIF(current_setting('app.current_school_id', true), '')::uuid
      OR current_setting('app.current_user_role', true) = 'system_admin'
    )
    AND (
      -- actor_user_id 側:
      --   system_admin は NULL / 任意 uuid どちらも許可 (cross-tenant 内部操作)
      --   それ以外のロールは自分自身の user_id に完全一致のみ (NULL 拒否、詐称防止)
      current_setting('app.current_user_role', true) = 'system_admin'
      OR actor_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    )
  );
