import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #48-K2 / #48-K3: HierarchyManager の **UI 配線**検証。Server Action は hub-actions.test.ts で実証済みなので、
 * ここは「⋯ メニュー / 一括操作 / 学年単位化 が正しいアクションを正しい引数で呼ぶ」ことだけ固める
 * （認可/検証/監査は不問）。再設計で操作は行末の ⋯ メニューに集約され、削除は restrict（配下があれば
 * ガード・空なら確認）になった。
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/school-admin/hub-actions", () => ({
  createDepartmentAction: vi.fn(),
  updateDepartmentAction: vi.fn(),
  deleteDepartmentAction: vi.fn(),
  createGradeAction: vi.fn(),
  updateGradeAction: vi.fn(),
  deleteGradeAction: vi.fn(),
  createClassAction: vi.fn(),
  updateClassAction: vi.fn(),
  deleteClassAction: vi.fn(),
}));

import { HierarchyManager } from "../../app/admin/school/_components/HierarchyManager";
import {
  createClassAction,
  createGradeAction,
  deleteClassAction,
  deleteDepartmentAction,
  updateGradeAction,
} from "../../lib/school-admin/hub-actions";

const ok = { ok: true as const, data: { id: "x" } };
const createGradeMock = vi.mocked(createGradeAction);
const createClassMock = vi.mocked(createClassAction);
const updateGradeMock = vi.mocked(updateGradeAction);
const deleteDeptMock = vi.mocked(deleteDepartmentAction);
const deleteClassMock = vi.mocked(deleteClassAction);

const HIERARCHY = {
  departments: [
    { id: "d-elec", name: "電子工学科", displayOrder: 0 },
    { id: "d-mech", name: "機械科", displayOrder: 1 },
  ],
  grades: [
    {
      id: "g1",
      name: "電子工学科3年",
      displayOrder: 0,
      hasClasses: true,
      departmentId: "d-elec",
      classes: [{ id: "c1", name: "1組", academicYear: 2026, grade: 3 }],
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  createGradeMock.mockResolvedValue(ok);
  createClassMock.mockResolvedValue(ok);
  updateGradeMock.mockResolvedValue(ok);
  deleteDeptMock.mockResolvedValue(ok);
  deleteClassMock.mockResolvedValue(ok);
});
afterEach(() => vi.restoreAllMocks());

describe("HierarchyManager（⋯メニュー / 一括操作 / 学年単位 配線）", () => {
  it("学科・学年・クラスのツリーと操作メニューを出す", () => {
    render(<HierarchyManager hierarchy={HIERARCHY} />);
    expect(screen.getAllByText("電子工学科").length).toBeGreaterThan(0);
    expect(screen.getByText("電子工学科3年")).toBeInTheDocument();
    expect(screen.getByText(/1組/)).toBeInTheDocument();
    // 各エンティティの操作は ⋯ メニュー（aria-label に「操作」を含む）に集約されている。
    expect(screen.getAllByRole("button", { name: /操作/ }).length).toBeGreaterThanOrEqual(3);
  });

  it("配下が空の学科は ⋯→削除→確認 で deleteDepartmentAction(id) を呼ぶ", async () => {
    render(<HierarchyManager hierarchy={HIERARCHY} />);
    // 機械科（配下学年なし）の操作メニューを開く。
    const mech = screen.getByText("機械科").closest("section");
    if (!mech) throw new Error("機械科ノードが見つかりません");
    fireEvent.click(within(mech).getByRole("button", { name: "学科の操作" }));
    fireEvent.click(within(mech).getByRole("menuitem", { name: "削除" }));
    fireEvent.click(within(mech).getByRole("button", { name: "削除する" }));
    await waitFor(() => expect(deleteDeptMock).toHaveBeenCalledWith("d-mech"));
  });

  it("配下のある学科は ⋯→削除 でガードを出し、削除アクションを呼ばない", async () => {
    render(<HierarchyManager hierarchy={HIERARCHY} />);
    const elec = screen.getByText("電子工学科").closest("section");
    if (!elec) throw new Error("電子工学科ノードが見つかりません");
    fireEvent.click(within(elec).getByRole("button", { name: "学科の操作" }));
    fireEvent.click(within(elec).getByRole("menuitem", { name: "削除" }));
    expect(within(elec).getByText(/削除できません/)).toBeInTheDocument();
    expect(within(elec).queryByRole("button", { name: "削除する" })).toBeNull();
    expect(deleteDeptMock).not.toHaveBeenCalled();
  });

  it("「一括操作」→「全学科に一括追加」は各学科に {学科名}{学年名} を作る", async () => {
    render(<HierarchyManager hierarchy={HIERARCHY} />);
    fireEvent.click(screen.getByRole("button", { name: /一括操作/ }));
    fireEvent.change(screen.getByPlaceholderText("学年名（例: 1年）"), {
      target: { value: "1年" },
    });
    fireEvent.click(screen.getByRole("button", { name: "全学科に一括追加" }));
    await waitFor(() => expect(createGradeMock).toHaveBeenCalledTimes(2));
    expect(createGradeMock).toHaveBeenCalledWith({ name: "電子工学科1年", departmentId: "d-elec" });
    expect(createGradeMock).toHaveBeenCalledWith({ name: "機械科1年", departmentId: "d-mech" });
  });

  it("クラスは ⋯→削除→確認 で deleteClassAction(id) を呼ぶ", async () => {
    render(<HierarchyManager hierarchy={HIERARCHY} />);
    fireEvent.click(screen.getByRole("button", { name: "クラスの操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "削除" }));
    fireEvent.click(screen.getByRole("button", { name: "削除する" }));
    await waitFor(() => expect(deleteClassMock).toHaveBeenCalledWith("c1"));
  });

  it("組のない学年は『組に分けず学年単位にする』で裏方クラス作成＋hasClasses=false にする", async () => {
    const h = {
      departments: [{ id: "d1", name: "電子工学科", displayOrder: 0 }],
      grades: [
        {
          id: "g2",
          name: "電子工学科2年",
          displayOrder: 0,
          hasClasses: true,
          departmentId: "d1",
          classes: [],
        },
      ],
    };
    render(<HierarchyManager hierarchy={h} />);
    fireEvent.click(screen.getByRole("button", { name: "組に分けず学年単位にする" }));
    await waitFor(() =>
      expect(createClassMock).toHaveBeenCalledWith(
        expect.objectContaining({ gradeId: "g2", name: "電子工学科2年" }),
      ),
    );
    await waitFor(() =>
      expect(updateGradeMock).toHaveBeenCalledWith(
        expect.objectContaining({ id: "g2", hasClasses: false }),
      ),
    );
  });

  it("要整理（学科未所属の学年）は学科を選ぶと updateGradeAction(departmentId) を呼ぶ", async () => {
    const h = {
      departments: [{ id: "d1", name: "電子工学科", displayOrder: 0 }],
      grades: [
        {
          id: "g-orphan",
          name: "1年",
          displayOrder: 0,
          hasClasses: true,
          departmentId: null,
          classes: [],
        },
      ],
    };
    render(<HierarchyManager hierarchy={h} />);
    expect(screen.getByText(/要整理/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("1年の学科へ移動"), { target: { value: "d1" } });
    await waitFor(() =>
      expect(updateGradeMock).toHaveBeenCalledWith(
        expect.objectContaining({ id: "g-orphan", departmentId: "d1" }),
      ),
    );
  });

  it("学年単位の学年は ⋯→クラスに分ける で updateGradeAction(hasClasses:true) を呼ぶ", async () => {
    const h = {
      departments: [{ id: "d1", name: "電子工学科", displayOrder: 0 }],
      grades: [
        {
          id: "g-unit",
          name: "電子工学科2年",
          displayOrder: 0,
          hasClasses: false,
          departmentId: "d1",
          classes: [{ id: "cu", name: "電子工学科2年", academicYear: 2026, grade: 2 }],
        },
      ],
    };
    render(<HierarchyManager hierarchy={h} />);
    fireEvent.click(screen.getByRole("button", { name: "学年の操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "クラスに分ける" }));
    await waitFor(() =>
      expect(updateGradeMock).toHaveBeenCalledWith(
        expect.objectContaining({ id: "g-unit", hasClasses: true }),
      ),
    );
  });

  it("クラスを持つ学年は ⋯→削除 でガードを出し、確認ボタンを出さない", () => {
    render(<HierarchyManager hierarchy={HIERARCHY} />);
    fireEvent.click(screen.getByRole("button", { name: "学年の操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "削除" }));
    expect(screen.getByText(/削除できません/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "削除する" })).toBeNull();
  });

  it("statusByClass で公開中/エディタ導線を出す", () => {
    render(<HierarchyManager hierarchy={HIERARCHY} statusByClass={{ c1: true }} />);
    expect(screen.getByText("公開中")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "エディタ" })).toHaveAttribute(
      "href",
      "/admin/editor/c1",
    );
  });
});
