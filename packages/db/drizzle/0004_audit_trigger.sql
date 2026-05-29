-- audit_log の append-only 強制 + prev_hash / row_hash の自動計算
--
-- 不変条件 (NFR04):
--   1. audit_log は append-only。UPDATE / DELETE は trigger でエラー。
--      0001 で REVOKE もしているため、RLS とは無関係に拒否される（二段構え）。
--   2. hash chain:
--        row_hash = SHA-256(
--          coalesce(prev_hash, '') || coalesce(actor_user_id, '') ||
--          table_name || coalesce(record_id, '') ||
--          operation || occurred_at || diff::text
--        )
--      prev_hash は直前行の row_hash。先頭行は NULL。
--   3. INSERT 時、prev_hash と row_hash はクライアントが何を入れても trigger が上書きするため改竄不可。
--
-- 関連: NFR04, CLAUDE.md ルール 1, ADR-019

------------------------------------------------------------
-- append-only enforcement
------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit_log_prevent_modify() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % operation rejected', TG_OP
    USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS audit_log_no_update ON "audit_log";
--> statement-breakpoint
CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION audit_log_prevent_modify();
--> statement-breakpoint

DROP TRIGGER IF EXISTS audit_log_no_delete ON "audit_log";
--> statement-breakpoint
CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION audit_log_prevent_modify();
--> statement-breakpoint

------------------------------------------------------------
-- hash chain (prev_hash, row_hash) を BEFORE INSERT で計算
------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit_log_compute_hash() RETURNS trigger AS $$
DECLARE
  v_prev_hash text;
  v_payload text;
BEGIN
  -- 直前行 (occurred_at, id 順) の row_hash を取得。先頭は NULL。
  -- 注: 同一トランザクション内で並列 INSERT があると順序競合の可能性があるが、
  -- audit_log は単独 INSERT が前提（middleware が逐次 emit）。
  -- 並列ワークロード時は SERIALIZABLE / LOCK TABLE で逐次化する運用ガイドを別途用意。
  SELECT row_hash INTO v_prev_hash
    FROM "audit_log"
    ORDER BY occurred_at DESC, id DESC
    LIMIT 1;

  NEW.prev_hash := v_prev_hash;

  -- ハッシュ計算の入力。NULL を文字列化する際は coalesce で空文字に正規化する。
  v_payload :=
    coalesce(NEW.prev_hash, '') ||
    coalesce(NEW.actor_user_id::text, '') ||
    NEW.table_name ||
    coalesce(NEW.record_id::text, '') ||
    NEW.operation::text ||
    NEW.occurred_at::text ||
    NEW.diff::text;

  NEW.row_hash := encode(digest(v_payload, 'sha256'), 'hex');

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS audit_log_hash ON "audit_log";
--> statement-breakpoint
CREATE TRIGGER audit_log_hash
  BEFORE INSERT ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION audit_log_compute_hash();
