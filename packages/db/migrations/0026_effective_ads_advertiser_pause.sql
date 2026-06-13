-- =====================================================================
-- 0026_effective_ads_advertiser_pause.sql
-- 目的: 広告主の営業ステータスが「休止」(advertisers.status = paused) の広告を、
--       サイネージ配信 VIEW `effective_ads_per_class` から除外する (BUG-1)。
--
-- 背景 (Reviewer 重点確認ポイント):
--   * 運営の停止/再開ボタン (setAdvertiserActiveAction) は advertisers.status を
--     paused / active に切り替えるが、配信 VIEW は advertisers を一切参照しておらず、
--     休止にしても当該広告がサイネージに出続けていた。緊急停止スイッチが実効性を
--     持たない最重要バグ (BUGS-運営整理 BUG-1)。
--   * `advertisers` は cross-tenant マスタで RLS `system_admin_full_access` (0002) に
--     より **system_admin 以外は 0 行** しか見えない。一方サイネージ配信は匿名
--     magic-link の school コンテキスト (withTenantContext / 非 system_admin) で走る。
--     よって VIEW を security_invoker=true のまま advertisers に JOIN すると、配信側
--     からは全 advertiser 行が不可視 = adv.status が NULL になり、広告主に紐づく広告が
--     **すべて** 落ちる致命的リグレッションになる。直接 JOIN は採れない。
--
-- 設計 (resolve_magic_link 関数 (0012) と同じ「RLS をくぐる細い扉」パターン):
--   * SECURITY DEFINER 関数 advertiser_is_deliverable(uuid) を 1 本だけ用意する。
--     所有者 (= migration 実行ロール、prod は migrator / CI は superuser) は
--     advertisers に FORCE ROW LEVEL SECURITY が無い (0001 は ENABLE のみ) ため RLS を
--     バイパスでき、テナント横断で当該 1 行の status だけを判定できる。
--   * 返すのは **boolean 1 個のみ**。広告主名・連絡先・備考などの CRM PII は一切
--     返さない (token 保持者が当然知ってよい最小情報のみ、の原則を踏襲)。
--   * advertiser_id = NULL (学校が自校で作るクラス広告など portal 非経由の広告) は
--     従来どおり配信対象 (true)。存在しない / 休止の広告主に紐づく広告のみ false。
--   * SQL injection 対策: SET search_path = '' (resolve_magic_link と同方針)。参照は
--     public.advertisers にスキーマ修飾し、enum リテラルも public.advertiser_status に
--     型修飾する。動的 SQL なし・引数は値としてのみ使用。
--   * STABLE: 同一 tx 内で副作用なし。VIEW の WHERE から広告 1 行あたり 1 回呼ぶが、
--     1 クラスの実効広告は数件で PK / ix_advertisers_status 引きのため安価。
--
-- 権限: PUBLIC から EXECUTE を剥がし、kimiterrace_app / kimiterrace_readonly にのみ
--       付与する (VIEW の GRANT 対象と一致。security_invoker の VIEW から呼べる必要)。
--
-- VIEW 変更: 既存 0011 の SELECT 列・FROM/JOIN・security_invoker=true はそのまま、
--            末尾に WHERE advertiser_is_deliverable(a.advertiser_id) を足すのみ。列構成は
--            不変なので CREATE OR REPLACE VIEW が許容される。
--
-- ADR-019 二層 RLS / CLAUDE.md ルール2 (RLS を DB レベルで強制) 準拠。
-- 前提: advertisers (advertiser_status enum)・ads.advertiser_id (0006/0011 系) 適用済。
-- =====================================================================

CREATE OR REPLACE FUNCTION advertiser_is_deliverable(p_advertiser_id uuid)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = ''
AS $$
  SELECT p_advertiser_id IS NULL
      OR EXISTS (
           SELECT 1
           FROM public.advertisers AS adv
           WHERE adv.id = p_advertiser_id
             AND adv.status <> 'paused'::public.advertiser_status
         );
$$;

REVOKE ALL ON FUNCTION advertiser_is_deliverable(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION advertiser_is_deliverable(uuid) TO kimiterrace_app, kimiterrace_readonly;

-- VIEW を再作成する。security_invoker=true は **必ず維持** (省略すると既定 false に
-- 戻り下層 classes/grades/ads の tenant_isolation が効かなくなる、ルール2)。
CREATE OR REPLACE VIEW effective_ads_per_class
  WITH (security_invoker = true) AS
SELECT
  c.id                 AS class_id,
  a.id                 AS ad_id,
  a.school_id          AS school_id,
  a.scope              AS source_scope,
  CASE a.scope
    WHEN 'school'     THEN 0
    WHEN 'department' THEN 1
    WHEN 'grade'      THEN 2
    WHEN 'class'      THEN 3
  END                  AS scope_rank,
  (a.scope <> 'class') AS is_inherited,
  a.media_url          AS media_url,
  a.media_type         AS media_type,
  a.duration_sec       AS duration_sec,
  a.link_url           AS link_url,
  a.caption            AS caption,
  a.caption_font_scale AS caption_font_scale,
  a.display_order      AS display_order
FROM classes c
-- 親学年経由で親学科を辿る (学科モード校のみ department_id が非 NULL)
LEFT JOIN grades g ON g.id = c.grade_id
JOIN ads a
  -- school_id 一致は system_admin (RLS バイパス) でも cross-tenant 結合を防ぐ多層防御
  ON a.school_id = c.school_id
 AND (
       a.scope = 'school'
    OR (a.scope = 'grade'      AND a.grade_id = c.grade_id)
    OR (a.scope = 'department' AND a.department_id = g.department_id)
    OR (a.scope = 'class'      AND a.class_id = c.id)
 )
-- BUG-1: 休止広告主 (advertisers.status = paused) の広告を配信から除外する。
-- security_invoker=true の配信ロールからは advertisers が不可視のため、直接 JOIN せず
-- SECURITY DEFINER 関数で status だけを判定する (広告主なし=NULL は従来どおり配信対象)。
WHERE advertiser_is_deliverable(a.advertiser_id);

-- security_invoker のため下層テーブルの権限も呼び出しロールで検査される。
-- CREATE OR REPLACE は既存 GRANT を保持するが、冪等性のため明示再付与する。
GRANT SELECT ON effective_ads_per_class TO kimiterrace_app, kimiterrace_readonly;
