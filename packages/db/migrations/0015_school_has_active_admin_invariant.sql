-- =====================================================================
-- 0015_school_has_active_admin_invariant.sql
-- 目的 (F11 / NFR04, #395 L2, ADR-026 L2 "preferred"):
--   「各校に有効な (is_active) school_admin が 1 名以上」を **DB レベルの不変条件**
--   として強制する多層防御。アプリ層 (#392) は無効化 / 降格の mirror tx 内で
--   `SELECT ... FOR UPDATE` 再カウントして last-admin の TOCTOU レースを根治済みだが、
--   それは Server Action seam を通る経路にしか効かない。本トリガは **その seam を
--   バイパスする経路** (直 SQL / 将来の別エンドポイント / 別バッチ) に対しても
--   「学校が管理者ゼロになる」のを DB が最終的に拒否する後段の砦。
--
-- 文脈 (Reviewer 重点確認ポイント):
--   * ADR-026 は「is_active / role の変更経路は D3 によりこの 2 アクションのみ」だが、
--     partial unique index では「各校に有効 school_admin >= 1」は表現できないため
--     トリガ / 制約関数が本命 (ADR-026 L2)。本 migration はそれを実装する。
--   * トリガはアプリ層ガードと **二重に** 効く。正常系 (アプリ経由) ではアプリが先に
--     LastAdminRaceError を投げて UPDATE 自体に到達しないため、トリガは発火しない
--     (= 既存挙動は不変)。トリガが実際に発火するのは seam を通らない経路だけ。
--
-- 直列化 (TOCTOU):
--   同一校の最後の 2 名を 2 接続が同時に取り除く競合は、count(read) と書込が同 tx でも
--   READ COMMITTED では両者が count>=1 を見て通過しうる。これを防ぐため、ガード対象の
--   遷移では **school 単位の xact-level advisory lock** を取ってから再カウントする。
--   - 行ロック / `schools` の FOR UPDATE と違い、テーブル行・FK key-share に干渉しないため
--     通常の user INSERT (生徒・教員の追加) をブロックしない。
--   - 並行する 2 つの除去操作は同一の advisory key で必ず競合し、ロック獲得順に直列化される。
--   - 後続 tx はロック解放後に新しいスナップショット (READ COMMITTED) で再カウントするため、
--     先行 tx が commit した除去を反映し、最後の 1 人を確実に検出して RAISE する。
--   - 前提: 1 文 = 単一校の除去。トリガは行単位 (FOR EACH ROW) で発火し、行ごとに OLD.school_id の
--     advisory lock を取る。1 つの SQL 文が**複数校**の管理者を一括除去すると、2 文が逆順に複数 school
--     key をロックし合う理論上の advisory deadlock 余地がある (PG が検出し片方を abort)。現状アプリには
--     該当パターンは無く (除去は単一行 seam のみ)、将来バッチで多校一括除去するなら school_id 昇順で
--     処理するか文を校ごとに分割すること。
--
-- RLS / 権限 (CLAUDE.md ルール2):
--   関数は **SECURITY INVOKER** (既定)。RLS をバイパスしない。テナント分離は school_id 単位
--   (ADR-019、role 境界ではない) のため、ある school_admin 行を UPDATE/DELETE できる呼び出し元は
--   同一校の全 users 行を読める ⟹ 同一校の有効 school_admin の count は権威的で、テナント越境の
--   過大計上も、同一校内の取りこぼしによる誤ブロックも起きない。SECURITY DEFINER で RLS を
--   バイパスする必要はない (ルール2 の「意図せぬ RLS バイパス」を避ける)。
--
-- カスタム SQLSTATE 'KT001' (KimiTerrace app-defined error, 001 = last-admin invariant):
--   汎用の check_violation (23514) と区別できるよう専用コードで RAISE する。アプリ側
--   (apps/web/lib/system-admin/users-actions.ts) はこれを検出して既存の last-admin 補償
--   (IdP revoke の巻き戻し + conflict) パスに合流させる (#392 と併用、ADR-026 L2)。
-- =====================================================================

CREATE OR REPLACE FUNCTION enforce_school_has_active_admin()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  affected_school uuid;
  remaining int;
BEGIN
  -- この操作が「ある学校から有効な school_admin を 1 人取り除く」遷移か判定する。
  -- 取り除かない遷移 (INSERT は対象外、昇格、teacher 操作、既に無効、別フィールドのみ更新) は
  -- そのまま通す (advisory lock も再カウントもしない = 通常更新を penalize しない)。
  IF (TG_OP = 'DELETE') THEN
    IF NOT (OLD.role = 'school_admin' AND OLD.is_active) THEN
      RETURN OLD;
    END IF;
    affected_school := OLD.school_id;
  ELSE  -- UPDATE
    IF NOT (OLD.role = 'school_admin' AND OLD.is_active) THEN
      RETURN NEW;  -- 元が「有効な school_admin」でなければ管理者を減らさない
    END IF;
    -- 更新後も「同一校の有効な school_admin」のままなら管理者を減らさない (no-op / 表示名更新等)
    IF (NEW.role = 'school_admin' AND NEW.is_active AND NEW.school_id = OLD.school_id) THEN
      RETURN NEW;
    END IF;
    affected_school := OLD.school_id;
  END IF;

  -- 同一校の管理者集合変更を直列化する (school 単位 xact-level advisory lock)。
  PERFORM pg_advisory_xact_lock(hashtextextended('kt:last_admin:' || affected_school::text, 0::bigint));

  -- 直列化後に「この操作の対象行 (OLD) を除いて残る有効 school_admin」を数える。
  -- BEFORE トリガなので NEW はまだ適用されておらず、OLD を除外した count がそのまま
  -- 「この操作完了後に残る有効 school_admin 数」になる。
  SELECT count(*) INTO remaining
  FROM users
  WHERE school_id = affected_school
    AND role = 'school_admin'
    AND is_active
    AND id <> OLD.id;

  IF remaining = 0 THEN
    RAISE EXCEPTION
      'school % must retain at least one active school_admin (last-admin invariant)', affected_school
      USING ERRCODE = 'KT001';
  END IF;

  IF (TG_OP = 'DELETE') THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

-- 冪等化 (loader は fresh DB で全件再適用するが、再実行に備える)。
DROP TRIGGER IF EXISTS trg_enforce_school_has_active_admin ON users;

CREATE TRIGGER trg_enforce_school_has_active_admin
  BEFORE UPDATE OR DELETE ON users
  FOR EACH ROW
  EXECUTE FUNCTION enforce_school_has_active_admin();
