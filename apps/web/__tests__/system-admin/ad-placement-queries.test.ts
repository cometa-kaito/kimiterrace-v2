import type { TenantTx } from "@kimiterrace/db";
import { describe, expect, it } from "vitest";
import { listSchoolClassesForAdPlacement } from "../../lib/system-admin/ad-placement-queries";

/**
 * F10 / #46: 運営の広告掲載導線用クラス一覧クエリの**マッピング**検証。Drizzle チェーンは fake tx で
 * 差し替え、select→from→leftJoin→where→orderBy の結果行を返す。検証対象は「gradeName null →
 * 『（学年未割当）』フォールバック」と行の射影 (テナント境界・SQL 自体は RLS / 実 PG の責務)。
 */

type Row = {
  classId: string;
  className: string;
  academicYear: number;
  grade: number;
  gradeName: string | null;
  departmentName: string | null;
};

/** select(...).from(...).leftJoin(...).where(...).orderBy(...) を満たし、最後に rows を解決する fake。 */
function fakeTx(rows: Row[]): TenantTx {
  const chain = {
    select: () => chain,
    from: () => chain,
    leftJoin: () => chain,
    where: () => chain,
    orderBy: () => Promise.resolve(rows),
  };
  return chain as unknown as TenantTx;
}

describe("listSchoolClassesForAdPlacement", () => {
  it("行を射影し、gradeName null は『（学年未割当）』に、departmentName を通す", async () => {
    const rows: Row[] = [
      // クラス制(学科なし)
      {
        classId: "c1",
        className: "1組",
        academicYear: 2026,
        grade: 1,
        gradeName: "1年",
        departmentName: null,
      },
      {
        classId: "c2",
        className: "未割当",
        academicYear: 2026,
        grade: 0,
        gradeName: null,
        departmentName: null,
      },
      // 学科制(学科あり) — departmentName をそのまま射影する (表示分岐に使う、BUG-3)
      {
        classId: "c3",
        className: "A組",
        academicYear: 2026,
        grade: 1,
        gradeName: "1年",
        departmentName: "電子工学科",
      },
    ];
    const result = await listSchoolClassesForAdPlacement(fakeTx(rows), "school-1");
    expect(result).toEqual([
      {
        classId: "c1",
        className: "1組",
        academicYear: 2026,
        gradeName: "1年",
        departmentName: null,
      },
      {
        classId: "c2",
        className: "未割当",
        academicYear: 2026,
        gradeName: "（学年未割当）",
        departmentName: null,
      },
      {
        classId: "c3",
        className: "A組",
        academicYear: 2026,
        gradeName: "1年",
        departmentName: "電子工学科",
      },
    ]);
  });

  it("クラスが無ければ空配列", async () => {
    expect(await listSchoolClassesForAdPlacement(fakeTx([]), "s")).toEqual([]);
  });
});
