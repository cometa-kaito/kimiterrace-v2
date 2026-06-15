import { describe, expect, it } from "vitest";
import { assembleSchoolTree } from "../../lib/system-admin/school-tree";

/**
 * 運営整理 §4 item3: 学校階層ツリー組み立て (assembleSchoolTree) の純テスト。
 * モニタの振り分け (class > grade > department > school)・空枝保持・決定的並びを固定する。
 * 実 DB 取得 (getSchoolTree) は RLS/PG 依存のため対象外。
 */

const device = (
  id: string,
  over: Partial<{
    label: string | null;
    classId: string | null;
    gradeId: string | null;
    departmentId: string | null;
  }> = {},
) => ({
  id,
  label: over.label ?? null,
  classId: over.classId ?? null,
  gradeId: over.gradeId ?? null,
  departmentId: over.departmentId ?? null,
  alertState: "ok" as const,
  lastSeenAt: null,
  monitoringEnabled: true,
});

describe("assembleSchoolTree", () => {
  it("クラスモード: 学年→クラス→モニタを組み立て、学年/学校レベルのモニタも保持する", () => {
    const tree = assembleSchoolTree({
      departments: [],
      grades: [
        { id: "g1", name: "1年", departmentId: null, displayOrder: 0 },
        { id: "g2", name: "2年", departmentId: null, displayOrder: 1 },
      ],
      classes: [
        { id: "c1", name: "A組", gradeId: "g1" },
        { id: "c2", name: "B組", gradeId: "g1" },
      ],
      devices: [
        device("d1", { classId: "c1", label: "1A教室" }),
        device("d2", { gradeId: "g1", label: "1年廊下" }), // 学年レベル
        device("d3", { label: "昇降口" }), // 学校レベル
      ],
    });

    expect(tree.departments).toEqual([]);
    expect(tree.grades.map((g) => g.name)).toEqual(["1年", "2年"]); // displayOrder 順
    const g1 = tree.grades[0];
    expect(g1?.classes.map((c) => c.name)).toEqual(["A組", "B組"]);
    expect(g1?.classes[0]?.devices.map((d) => d.id)).toEqual(["d1"]);
    expect(g1?.devices.map((d) => d.id)).toEqual(["d2"]); // 学年直下
    expect(tree.schoolDevices.map((d) => d.id)).toEqual(["d3"]);
    // 空枝保持: 2年はクラス無しでもノードが残る。
    expect(tree.grades[1]?.classes).toEqual([]);
  });

  it("学科モード: 学科→学年でグルーピングし、学科直下モニタも保持する", () => {
    const tree = assembleSchoolTree({
      departments: [
        { id: "dep1", name: "電子工学科", displayOrder: 0 },
        { id: "dep2", name: "機械科", displayOrder: 1 },
      ],
      grades: [{ id: "g1", name: "1年", departmentId: "dep1", displayOrder: 0 }],
      classes: [],
      devices: [device("d1", { departmentId: "dep1", label: "学科掲示板" })],
    });

    expect(tree.departments.map((d) => d.name)).toEqual(["電子工学科", "機械科"]);
    expect(tree.departments[0]?.grades.map((g) => g.name)).toEqual(["1年"]);
    expect(tree.departments[0]?.devices.map((d) => d.id)).toEqual(["d1"]);
    expect(tree.departments[1]?.grades).toEqual([]); // 空学科も保持
    expect(tree.grades).toEqual([]); // 学科未割当の top-level 学年は無い
  });

  it("モニタは最も具体的なレベルへ振り分ける (class > grade > department > school)", () => {
    const tree = assembleSchoolTree({
      departments: [{ id: "dep1", name: "科", displayOrder: 0 }],
      grades: [{ id: "g1", name: "1年", departmentId: "dep1", displayOrder: 0 }],
      classes: [{ id: "c1", name: "A", gradeId: "g1" }],
      // class/grade/dept すべて指定されたデバイスは class に置かれる。
      devices: [device("d1", { classId: "c1", gradeId: "g1", departmentId: "dep1" })],
    });
    expect(tree.departments[0]?.grades[0]?.classes[0]?.devices.map((d) => d.id)).toEqual(["d1"]);
    expect(tree.departments[0]?.grades[0]?.devices).toEqual([]);
    expect(tree.departments[0]?.devices).toEqual([]);
    expect(tree.schoolDevices).toEqual([]);
  });

  it("クラスは名前→id、モニタはラベル→id で決定的に並ぶ", () => {
    const tree = assembleSchoolTree({
      departments: [],
      grades: [{ id: "g1", name: "1年", departmentId: null, displayOrder: 0 }],
      classes: [
        { id: "c-b", name: "B組", gradeId: "g1" },
        { id: "c-a", name: "A組", gradeId: "g1" },
      ],
      devices: [
        device("dz", { label: "Z" }),
        device("da", { label: "A" }),
        device("dn", { label: null }),
      ],
    });
    // 名前昇順 (A組 が先)。
    expect(tree.grades[0]?.classes.map((c) => c.name)).toEqual(["A組", "B組"]);
    // 学校レベルモニタ: null(空文字) → "A" → "Z"。
    expect(tree.schoolDevices.map((d) => d.id)).toEqual(["dn", "da", "dz"]);
  });

  it("学年未割当 (grade_id null) のクラスはツリーに出さない", () => {
    const tree = assembleSchoolTree({
      departments: [],
      grades: [{ id: "g1", name: "1年", departmentId: null, displayOrder: 0 }],
      classes: [{ id: "c1", name: "浮きクラス", gradeId: null }],
      devices: [],
    });
    expect(tree.grades[0]?.classes).toEqual([]);
  });
});
