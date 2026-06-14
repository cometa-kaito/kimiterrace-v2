import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createSql, getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * 「新年度へ複製」(duplicateClassesToNextYearAction) の翌年度クラス重複生成を恒久的に封じる部分 UNIQUE
 * index `ux_classes_school_year_grade_name` (school_id, academic_year, grade_id, name) WHERE
 * grade_id IS NOT NULL を実 PG で検証する。並行実行/別タブ再実行の TOCTOU は app 層 (planNextYear
 * Duplication + 既存 target 除外) では塞ぎきれず、本 index が直列化の真の砦になる（migration
 * `drizzle/20260614024542_chilly_guardsmen.sql`）。
 *
 * 重点（鍵の各次元が効いていること）:
 *   1. 同一 (school, year, grade_id, name) の 2 件目を拒否（重複生成の封鎖・本丸）。
 *   2. school_id 次元: 別校なら同 (year, grade_id 概念, name) でも衝突しない（テナント整合）。
 *   3. grade_id 次元: 同校・同年度・同名でも別学年なら衝突しない。
 *   4. academic_year 次元: 同校・同学年・同名でも別年度なら衝突しない（複製で 1 年進む前提）。
 *   5. 部分性: grade_id IS NULL（学年未割当）は index 対象外で重複可（複製対象外かつ階層外）。
 *
 * index は role 非依存ゆえ owner 接続(BYPASSRLS)の直接 INSERT で検証する（RLS は別スイートが担保）。
 * 実 PG が要るため DATABASE_URL 未設定ではスキップ（CI Test job で実走）。
 */
describeOrSkip(
  "classes 部分 UNIQUE index: 新年度複製の重複封鎖 (ux_classes_school_year_grade_name)",
  () => {
    // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
    const sql = createSql(url!);
    let fx: Awaited<ReturnType<typeof seedBaseFixture>>;
    let gradeA1: string;
    let gradeA2: string;
    let gradeB1: string;

    beforeEach(async () => {
      fx = await seedBaseFixture(sql);
      await sql`RESET ROLE`;
      // school A は 2 学年（grade_id 次元の検証用）、school B は 1 学年。grades は (school_id,name) 一意。
      const [a1] = await sql<{ id: string }[]>`
      INSERT INTO grades (school_id, name, display_order) VALUES (${fx.schoolA}, '1年', 1) RETURNING id
    `;
      const [a2] = await sql<{ id: string }[]>`
      INSERT INTO grades (school_id, name, display_order) VALUES (${fx.schoolA}, '2年', 2) RETURNING id
    `;
      const [b1] = await sql<{ id: string }[]>`
      INSERT INTO grades (school_id, name, display_order) VALUES (${fx.schoolB}, '1年', 1) RETURNING id
    `;
      gradeA1 = a1.id;
      gradeA2 = a2.id;
      gradeB1 = b1.id;
    });

    afterAll(async () => {
      await sql.end({ timeout: 5 });
    });

    async function insertClass(
      schoolId: string,
      year: number,
      gradeId: string | null,
      name: string,
      grade: number,
    ): Promise<void> {
      await sql`
      INSERT INTO classes (school_id, academic_year, grade_id, name, grade)
      VALUES (${schoolId}, ${year}, ${gradeId}, ${name}, ${grade})
    `;
    }

    it("同一 (school, year, grade_id, name) の 2 件目は 23505 で拒否（重複封鎖の本丸）", async () => {
      await insertClass(fx.schoolA, 2027, gradeA1, "1組", 1);
      await expect(insertClass(fx.schoolA, 2027, gradeA1, "1組", 1)).rejects.toThrow(
        /ux_classes_school_year_grade_name|duplicate key|unique/i,
      );
    });

    it("別校なら同年度・同名でも衝突しない（school_id 次元・テナント整合）", async () => {
      await insertClass(fx.schoolA, 2027, gradeA1, "1組", 1);
      await insertClass(fx.schoolB, 2027, gradeB1, "1組", 1);
      const rows = await sql<
        { c: string }[]
      >`SELECT count(*)::text AS c FROM classes WHERE name = '1組'`;
      expect(Number(rows[0].c)).toBe(2);
    });

    it("同校・同年度・同名でも別学年(grade_id)なら衝突しない（grade_id 次元）", async () => {
      await insertClass(fx.schoolA, 2027, gradeA1, "1組", 1);
      await insertClass(fx.schoolA, 2027, gradeA2, "1組", 2);
      const rows = await sql<
        { c: string }[]
      >`SELECT count(*)::text AS c FROM classes WHERE name = '1組'`;
      expect(Number(rows[0].c)).toBe(2);
    });

    it("同校・同学年・同名でも別年度なら衝突しない（academic_year 次元・複製で 1 年進む前提）", async () => {
      await insertClass(fx.schoolA, 2027, gradeA1, "1組", 1);
      await insertClass(fx.schoolA, 2028, gradeA1, "1組", 1);
      const rows = await sql<
        { c: string }[]
      >`SELECT count(*)::text AS c FROM classes WHERE name = '1組'`;
      expect(Number(rows[0].c)).toBe(2);
    });

    it("grade_id IS NULL（学年未割当）は部分 index 対象外で重複可（複製対象外・階層外）", async () => {
      await insertClass(fx.schoolA, 2027, null, "未割当", 1);
      await insertClass(fx.schoolA, 2027, null, "未割当", 1);
      const rows = await sql<{ c: string }[]>`
      SELECT count(*)::text AS c FROM classes WHERE grade_id IS NULL AND name = '未割当'
    `;
      expect(Number(rows[0].c)).toBe(2);
    });
  },
);
