-- ads の冪等キーを (portal_placement_id, school_id) の複合へ広げる。
--
-- 背景: portal の複数校ループ（1申込＝N校 同時配信・portal migration 0076/0092）は、1つの placement
--   から **校ごとに1広告行**を生む必要がある。portal_placement_id 単独 UNIQUE では
--   ON CONFLICT DO UPDATE が順に上書きし、エラーも出さずに最後の1校だけが残る
--   （＝「3校に出ている」と誤認したまま1校配信）。そのため portal 側は複数校ループの配信を
--   保留していた。この索引の付け替えで解禁する。
--
-- 安全性: 単独 UNIQUE → 複合 UNIQUE は **制約の緩和**（今まで通っていた行は必ず通る）。
--   既存行は portal_placement_id が互いに異なるため重複は発生しない。NULL は従来どおり複数行可。
DROP INDEX IF EXISTS "ux_ads_portal_placement_id";--> statement-breakpoint
CREATE UNIQUE INDEX "ux_ads_portal_placement_school" ON "ads" USING btree ("portal_placement_id","school_id");