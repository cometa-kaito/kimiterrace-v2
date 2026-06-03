-- =====================================================================
-- 0020_contract_contents_rls.sql
-- 目的: F10 (#46) で追加した契約 ⇄ 出稿コンテンツの紐付け中間表
--       contract_contents に RLS（CRM system_admin_only パターン）+ 監査 FK を付与する。
--
-- 前提: drizzle/20260603042342_f10_contract_contents.sql で contract_contents が作成済であること。
--
-- =====================================================================
-- ★ なぜ tenant_isolation ではなく system_admin_full_access のみか
--   （ADR-019 二層モデル / F10 受け入れ条件 / CLAUDE.md ルール2）
-- =====================================================================
-- contract_contents は **school_id を持たない cross-tenant CRM 関連表**。親の contracts /
-- advertisers / communications と同じく「全校横断の営業・契約データ」で、school_admin 以下には
-- DB レベルで一切見せない。よって RLS は school_id 一致の tenant_isolation ではなく、
-- `system_admin_full_access`（role='system_admin' のみ全 CRUD 可）**1 本のみ**を貼る。
--   - system_admin context（app.current_user_role='system_admin'）: 全件 SELECT / INSERT / UPDATE / DELETE 可
--   - school_admin / teacher / student / guardian / 匿名 / context 未設定: どの policy も通らず **0 行**
--     （deny-by-default。tenant_isolation を貼らないので「自校分だけ見える」抜け穴も無い）
--
-- ★ Reviewer 重点: tenant_isolation を**貼らないこと**が本表の安全性の肝。
--   万一 tenant_isolation を貼ると、本表は school_id を持たないため述語が常に NULL=偽 になり全 deny に
--   見えるが、将来 school_id 列を足すと意図せず横断可視になりうる。CRM 関連表は system_admin_only で
--   固定する（contracts/communications/feedback と同系統）。
--
-- ★ 紐付いた contents のタイトル取得の可視性:
--   表示は contract_contents ⋈ contents で行うが、contents には migration 0002 で
--   system_admin_full_access policy が貼られている。よって system_admin context では cross-tenant に
--   全 contents が可視で、結合は成立する。非 system_admin は本表自体が 0 行なので結合結果も空（多層防御）。
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) RLS 有効化（ENABLE のみ。FORCE はしない = テーブル所有者/migrator はバイパス可）
--    contracts/advertisers/communications と同じ ENABLE 止まり（FORCE は audit_log のみ）。
-- ---------------------------------------------------------------------
ALTER TABLE contract_contents ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------
-- 2) system_admin_full_access policy（FOR ALL = SELECT/INSERT/UPDATE/DELETE）
--    USING（既存行の可視）/ WITH CHECK（新規・更新行の許可）とも role='system_admin' のみ true。
--    WITH CHECK を入れないと非 system_admin が INSERT で行を差し込める穴が残る（0002 と同規律）。
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS system_admin_full_access ON contract_contents;
CREATE POLICY system_admin_full_access ON contract_contents FOR ALL
  USING (current_setting('app.current_user_role', true) = 'system_admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'system_admin');

-- ---------------------------------------------------------------------
-- 3) 監査 FK: created_by / updated_by → users(id) ON DELETE SET NULL
--    link/unlink は system_admin が行い、system_admin は users 行ではないため NULL になる
--    （contracts と同じ扱い）。
--    （src/_shared/audit.ts は循環依存回避で FK 未宣言。0004/0006/0014/0017 と同じ後付けパターン）
-- ---------------------------------------------------------------------
ALTER TABLE contract_contents DROP CONSTRAINT IF EXISTS contract_contents_created_by_users_fk;
ALTER TABLE contract_contents
  ADD CONSTRAINT contract_contents_created_by_users_fk
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE contract_contents DROP CONSTRAINT IF EXISTS contract_contents_updated_by_users_fk;
ALTER TABLE contract_contents
  ADD CONSTRAINT contract_contents_updated_by_users_fk
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL;
