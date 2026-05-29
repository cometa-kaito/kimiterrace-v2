-- =====================================================================
-- 0003_audit_trigger.sql
-- 目的: audit_log の append-only 強制 + hash chain 自動計算
--
-- NFR04 要件:
--   1. UPDATE / DELETE は禁止 (append-only)
--   2. 各行は直前行の row_hash を prev_hash に持ち、
--      row_hash = SHA-256(prev_hash || actor_user_id || table_name ||
--                          record_id || operation || occurred_at || diff)
--      で連鎖。任意の行の改竄を後段の row_hash 計算が検出する。
--
-- 改竄防止のため pgcrypto 拡張 (digest 関数) を利用する。
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------
-- (1) append-only: UPDATE / DELETE を BEFORE トリガで拒否
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit_log_block_update_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'audit_log is append-only: % is not permitted (NFR04 / CLAUDE.md rule 1)',
    TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_block_update_delete();

DROP TRIGGER IF EXISTS audit_log_no_delete ON audit_log;
CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_block_update_delete();

-- TRUNCATE もブロック (BEFORE UPDATE/DELETE では拾えない)
CREATE OR REPLACE FUNCTION audit_log_block_truncate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'audit_log is append-only: TRUNCATE is not permitted (NFR04 / CLAUDE.md rule 1)'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS audit_log_no_truncate ON audit_log;
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_block_truncate();

-- ---------------------------------------------------------------------
-- (2) hash chain: prev_hash / row_hash を自動計算
--
-- 設計:
--   - 入力された prev_hash / row_hash は無条件で上書きする (改竄入力対策)。
--   - prev_hash は直前 (occurred_at, id) 行の row_hash。テーブル全体で 1 本の chain。
--   - row_hash = SHA-256(prev_hash || canonical(payload)) を hex 文字列で格納。
--   - 並行 INSERT の競合は本テーブルへの advisory lock で直列化する。
--     (本テーブルの append レートは秒間数件以下を想定しており、ロック衝突は許容)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit_log_set_hash()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_prev_hash text;
  v_payload   text;
BEGIN
  -- chain を直列化 (audit_log のテーブル単位 advisory lock)
  -- 'audit_log' の hashtext を bigint として使う (固定キー)
  PERFORM pg_advisory_xact_lock(hashtext('audit_log')::bigint);

  -- 直前行の row_hash を取得 (なければ null = 先頭行)
  SELECT row_hash INTO v_prev_hash
    FROM audit_log
   ORDER BY occurred_at DESC, id DESC
   LIMIT 1;

  NEW.prev_hash := v_prev_hash;

  -- canonical payload: 順序固定で連結。null は '' に正規化。
  v_payload := COALESCE(v_prev_hash, '')
            || '|' || COALESCE(NEW.actor_user_id::text, '')
            || '|' || NEW.table_name
            || '|' || COALESCE(NEW.record_id::text, '')
            || '|' || NEW.operation::text
            || '|' || NEW.occurred_at::text
            || '|' || COALESCE(NEW.diff::text, '{}');

  NEW.row_hash := encode(digest(v_payload, 'sha256'), 'hex');

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS audit_log_hash_chain ON audit_log;
CREATE TRIGGER audit_log_hash_chain
  BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_set_hash();

-- ---------------------------------------------------------------------
-- 補助: chain の整合性検証関数 (テストおよび運用監査で使用)
--
-- 戻り値: 不整合行の id 配列。空配列なら chain 健全。
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit_log_verify_chain()
RETURNS TABLE (broken_id uuid, expected_hash text, stored_hash text)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  r          record;
  v_prev     text := NULL;
  v_expected text;
  v_payload  text;
BEGIN
  FOR r IN
    SELECT id, occurred_at, actor_user_id, table_name, record_id,
           operation, diff, prev_hash, row_hash
      FROM audit_log
     ORDER BY occurred_at ASC, id ASC
  LOOP
    v_payload := COALESCE(v_prev, '')
              || '|' || COALESCE(r.actor_user_id::text, '')
              || '|' || r.table_name
              || '|' || COALESCE(r.record_id::text, '')
              || '|' || r.operation::text
              || '|' || r.occurred_at::text
              || '|' || COALESCE(r.diff::text, '{}');
    v_expected := encode(digest(v_payload, 'sha256'), 'hex');

    IF r.prev_hash IS DISTINCT FROM v_prev OR r.row_hash <> v_expected THEN
      broken_id      := r.id;
      expected_hash  := v_expected;
      stored_hash    := r.row_hash;
      RETURN NEXT;
    END IF;

    v_prev := r.row_hash;
  END LOOP;
END;
$$;
