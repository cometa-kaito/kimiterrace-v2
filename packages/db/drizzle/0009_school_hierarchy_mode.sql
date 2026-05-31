-- #48-L (#123): schools に hierarchy_mode 列を追加 (V1 schools.hierarchyMode 相当)。
-- class=学年>クラス / department=学年>学科>クラス。既存校は普通科前提で 'class' をデフォルト。
--
-- 手書き migration: drizzle-kit generate は meta journal (0000-0003 のみ追跡) のドリフトを
-- 1 ファイルに巻き込むため (teacher_inputs / composite FK 等)、本ドメインの差分のみを切り出して
-- 手書きする (global-setup.ts が path 指定で順次ロードする運用に合わせる)。enum の DROP TYPE は
-- 発生しない (新規 CREATE TYPE のみ、Issue #101 / PR #104 のパターン)。
CREATE TYPE "public"."school_hierarchy_mode" AS ENUM('class', 'department');--> statement-breakpoint
ALTER TABLE "schools" ADD COLUMN "hierarchy_mode" "school_hierarchy_mode" DEFAULT 'class' NOT NULL;
