-- =====================================================================
-- 0032_school_calendar_rls.sql
-- 目的: ADR-045 で追加した学校行事カレンダーの per-school テーブル
--       school_calendar_sources / school_calendar_events に
--       RLS（テナント分離）+ 監査 FK を付与する。
--
-- 前提: drizzle 自動生成 migration（idx38 / 20260618122108_school_calendar.sql）で
--       両テーブルが作成済であること（手書き RLS の本ファイルは drizzle DDL 適用後に流す）。
--
-- 構成（既存 0016_tv_devices_rls.sql と同一パターン、対象 2 テーブル）:
--   1. ENABLE ROW LEVEL SECURITY
--   2. tenant_isolation policy（school_id 一致、FOR ALL、USING + WITH CHECK）
--   3. system_admin_full_access policy（role = 'system_admin'、取得 Job / 管理用）
--   4. created_by / updated_by → users(id) FK（ON DELETE SET NULL）
--
-- ADR-019 二層 RLS モデル / CLAUDE.md ルール1・2 準拠。
-- =====================================================================
-- ★ なぜ tenant_isolation か（ADR-045 §決定 2 / weather_warnings の read_all とは異なる）
-- =====================================================================
-- 学校行事カレンダーは **学校固有データ**（その学校の始業式・体育祭・定期試験等）であり、weather_warnings の
-- ような「学校横断の公開・非 PII 共有キャッシュ」ではない。よって RLS は school_id を持たない公開参照
-- （read_all USING(true)）ではなく、daily_data / tv_devices と同じ **tenant_isolation**（school_id 一致）を採る。
-- これにより:
--   - 自校コンテキスト（school_admin / teacher / student / guardian、または匿名サイネージ = role 未設定で
--     school_id のみ set）は **自校の行事のみ**読める。
--   - **他校の行事は不可視**（school_id 不一致で 0 行）。これが本 PR の肝（テナント分離、ルール2）。
--   - 取得 Job（既存の天気 Job に per-school フェーズで相乗り、ADR-045 §決定 3）は **system_admin context**
--     で各校の school_id を明示して cross-tenant に列挙・upsert する（system_admin_full_access、BYPASSRLS 不使用）。
--
-- ★ サイネージ匿名読み取り（ADR-016）: サイネージ端末は role を SET せず school_id のみ set する
--   deny-by-default 接続。tenant_isolation の USING は `school_id = current_school_id` なので、school_id を
--   set した自校の行事は読める（role に依存しない）。§RLS テストで「匿名 school_id set で自校のみ読める /
--   他校は読めない」ことを固定する。
--
-- ★ PII / サイネージ露出（ルール4 / ADR-045）: 本テーブルには公開行事名・場所・公開 iCal URL・取得失敗理由
--   （lastError、PII 非格納）のみを格納し、生徒氏名等の PII を含む私的カレンダーを繋がない運用前提。tenant_isolation
--   で他校から不可視。LLM / embedding 経路には載せない。
-- =====================================================================

-- =====================================================================
-- school_calendar_sources
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) RLS 有効化
-- ---------------------------------------------------------------------
ALTER TABLE school_calendar_sources ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------
-- 2) tenant_isolation policy
--    USING: 既存行が可視か / WITH CHECK: 新規行が許可されるか
--    NULLIF(..., '') は current_setting の missing_ok モードが空文字を返すケースの
--    fail-closed 対策（全 policy に適用済のパターン）。
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS tenant_isolation ON school_calendar_sources;
CREATE POLICY tenant_isolation ON school_calendar_sources FOR ALL
  USING (school_id = NULLIF(current_setting('app.current_school_id', true), '')::uuid)
  WITH CHECK (school_id = NULLIF(current_setting('app.current_school_id', true), '')::uuid);

-- ---------------------------------------------------------------------
-- 3) system_admin_full_access policy（cross-tenant、role = 'system_admin'）
--    取得 Job の per-school フェーズ列挙・全校横断管理は system_admin が行う。
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS system_admin_full_access ON school_calendar_sources;
CREATE POLICY system_admin_full_access ON school_calendar_sources FOR ALL
  USING (current_setting('app.current_user_role', true) = 'system_admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'system_admin');

-- ---------------------------------------------------------------------
-- 4) 監査 FK: created_by / updated_by → users(id) ON DELETE SET NULL
--    （src/_shared/audit.ts は循環依存回避で FK 未宣言。0016 と同じ後付けパターン）
-- ---------------------------------------------------------------------
ALTER TABLE school_calendar_sources DROP CONSTRAINT IF EXISTS school_calendar_sources_created_by_users_fk;
ALTER TABLE school_calendar_sources
  ADD CONSTRAINT school_calendar_sources_created_by_users_fk
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE school_calendar_sources DROP CONSTRAINT IF EXISTS school_calendar_sources_updated_by_users_fk;
ALTER TABLE school_calendar_sources
  ADD CONSTRAINT school_calendar_sources_updated_by_users_fk
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL;

-- =====================================================================
-- school_calendar_events
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) RLS 有効化
-- ---------------------------------------------------------------------
ALTER TABLE school_calendar_events ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------
-- 2) tenant_isolation policy（自校イベントのみ可視・書込可。匿名サイネージは school_id set で自校のみ読める）
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS tenant_isolation ON school_calendar_events;
CREATE POLICY tenant_isolation ON school_calendar_events FOR ALL
  USING (school_id = NULLIF(current_setting('app.current_school_id', true), '')::uuid)
  WITH CHECK (school_id = NULLIF(current_setting('app.current_school_id', true), '')::uuid);

-- ---------------------------------------------------------------------
-- 3) system_admin_full_access policy（取得 Job の cross-tenant upsert / 掃除）
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS system_admin_full_access ON school_calendar_events;
CREATE POLICY system_admin_full_access ON school_calendar_events FOR ALL
  USING (current_setting('app.current_user_role', true) = 'system_admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'system_admin');

-- ---------------------------------------------------------------------
-- 4) 監査 FK: created_by / updated_by → users(id) ON DELETE SET NULL
--    取得 Job の書き込みは null（システム = system://calendar-fetch）。
-- ---------------------------------------------------------------------
ALTER TABLE school_calendar_events DROP CONSTRAINT IF EXISTS school_calendar_events_created_by_users_fk;
ALTER TABLE school_calendar_events
  ADD CONSTRAINT school_calendar_events_created_by_users_fk
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE school_calendar_events DROP CONSTRAINT IF EXISTS school_calendar_events_updated_by_users_fk;
ALTER TABLE school_calendar_events
  ADD CONSTRAINT school_calendar_events_updated_by_users_fk
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL;
