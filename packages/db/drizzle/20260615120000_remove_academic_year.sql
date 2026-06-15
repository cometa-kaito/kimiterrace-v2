-- 年度（academic_year / クラスを年度で分ける機能）の完全撤去。クラスは校内の単一集合になる。
--
-- 変更内容:
--   1. 年度キーの index `ix_classes_school_year` (school_id, academic_year) を drop。
--   2. 旧・新年度複製の重複封鎖 index `ux_classes_school_year_grade_name`
--      (school_id, academic_year, grade_id, name) WHERE grade_id IS NOT NULL を drop。
--   3. `classes.academic_year` 列 (NOT NULL integer) を drop。
--   4. 校内クラスの一意性を担保する新・部分 UNIQUE index `ux_classes_school_grade_name`
--      (school_id, grade_id, name) WHERE grade_id IS NOT NULL を create。
--
-- ========================== 本番適用ゲート（重要・Rule 8） ==========================
-- 本 migration は **破壊的**。新 index `ux_classes_school_grade_name` は
-- (school_id, grade_id, name) を一意にするため、「新年度へ複製」で作られた **年度違いの同名クラス**
-- （例: 2026 年度 1組 と 2027 年度 1組 が同一 grade_id 配下にある）があると CREATE 自体が 23505 で失敗する。
--
-- このため、本番（および同名重複を含みうる環境）への適用前に **同名重複の名寄せ（dedup）が必須**。
-- migration 内ではデータ名寄せをしない（本番データに依存する判断のため）。適用は人手のゲートを経ること。
--
-- 適用前チェック（重複が無いことを確認、あれば名寄せしてから apply）:
--   SELECT school_id, grade_id, name, count(*)
--   FROM classes WHERE grade_id IS NOT NULL
--   GROUP BY 1,2,3 HAVING count(*) > 1;
--
-- 名寄せの基本方針（運用判断のうえ実施・本 migration には含めない）:
--   - 残す 1 行を決める（通常は最新年度の行 = 在校生が紐づく現役クラス）。
--   - 旧年度の重複クラスにぶら下がる子参照（ai_chat_sessions / magic_links / daily_data / ads / tv_devices 等）を
--     残す行へ付替えるか、不要なら削除する。子の付替/削除の順序と監査（ルール1）に注意する。
--   - 学年未割当 (grade_id IS NULL) のクラスは新 index 対象外ゆえ dedup 不要。
-- 岐南は各学年 1 クラスのため通常は重複なし（即 apply 可）。
-- ====================================================================================

DROP INDEX "ix_classes_school_year";--> statement-breakpoint
DROP INDEX "ux_classes_school_year_grade_name";--> statement-breakpoint
ALTER TABLE "classes" DROP COLUMN "academic_year";--> statement-breakpoint
CREATE UNIQUE INDEX "ux_classes_school_grade_name" ON "classes" USING btree ("school_id","grade_id","name") WHERE "classes"."grade_id" IS NOT NULL;
