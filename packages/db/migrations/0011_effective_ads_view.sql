-- =====================================================================
-- 0011_effective_ads_view.sql (旧 0007、loader auto-discovery のリナンバ)
-- 目的: 広告の「学校 → 学科 → 学年 → クラス」階層マージを 1 クラス単位で
--       解決する VIEW `effective_ads_per_class` を作成する (#48-F)。
--
-- 設計判断 (Reviewer 重点確認ポイント):
--   * MATERIALIZED VIEW ではなく通常 VIEW + `security_invoker = true` を採用。
--     理由 1 (セキュリティ): PostgreSQL の Materialized View は RLS を尊重しない
--       (REFRESH 時の所有者権限でスナップショットを作り、SELECT 時にテナント分離が
--        効かない)。これは CLAUDE.md ルール2「RLS を DB レベルで強制」に反する。
--       `security_invoker = true` (PG15+, 本番/CI は PG16) は呼び出しロールの
--       権限と RLS コンテキストで実行されるため、下層 classes/grades/ads の
--       `tenant_isolation` がクエリ時に強制される。
--     理由 2 (鮮度): MV は REFRESH 遅延を生み F04「即公開」と矛盾。広告編集が
--       即サイネージに反映される必要があるため、オンデマンド評価の通常 VIEW が適切。
--     理由 3 (コスト): 1 クラスあたりの実効広告は数件、索引付き等価結合で安価。
--       50 端末/校 のポーリングに対し REFRESH より都度評価のほうが軽い。
--
--   * 親階層 (school/department/grade) の広告は子クラスに「伝搬」する。
--     `is_inherited = (scope <> 'class')` で示し、UI 側はこれを編集不可フラグに使う
--     (V1 HierarchicalAdsTab の「親階層広告は編集不可」挙動の移植)。
--
--   * `scope_rank` (school=0 / department=1 / grade=2 / class=3) を列で持ち、
--     クエリ層が (scope_rank, display_order, ad_id) で安定ソートする
--     (広 → 狭。決定的順序。再生制御 #48-G/#48-E 側で再ソート可)。
--
-- 前提:
--   * drizzle/0002_f0f_hierarchy_links.sql で classes.grade_id / grades.department_id 追加済
--   * grades/departments/classes/ads に RLS (0006_f0a_schema_rls.sql) 適用済
--
-- ADR-019 二層 RLS / CLAUDE.md ルール2・3 準拠。
-- =====================================================================

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
 );

-- アプリ接続ロールに参照権を付与 (0002 の GRANT ON ALL TABLES は本 VIEW 作成前に
-- 実行済のため明示付与が必要)。security_invoker のため下層テーブルの権限も
-- 呼び出しロール (kimiterrace_app は全テーブル SELECT 済) で検査される。
GRANT SELECT ON effective_ads_per_class TO kimiterrace_app, kimiterrace_readonly;
