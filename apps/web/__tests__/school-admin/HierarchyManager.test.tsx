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
  duplicateClassesToNextYearAction: vi.fn(),
  reorderHierarchyAction: vi.fn(),
}));

import { HierarchyManager } from "../../app/app/school/_components/HierarchyManager";
import {
  createClassAction,
  createGradeAction,
  deleteClassAction,
  deleteDepartmentAction,
  duplicateClassesToNextYearAction,
  reorderHierarchyAction,
  updateGradeAction,
} from "../../lib/school-admin/hub-actions";

const ok = { ok: true as const, data: { id: "x" } };
const createGradeMock = vi.mocked(createGradeAction);
const createClassMock = vi.mocked(createClassAction);
const updateGradeMock = vi.mocked(updateGradeAction);
const deleteDeptMock = vi.mocked(deleteDepartmentAction);
const deleteClassMock = vi.mocked(deleteClassAction);
const dupMock = vi.mocked(duplicateClassesToNextYearAction);
const reorderMock = vi.mocked(reorderHierarchyAction);

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
  dupMock.mockResolvedValue({ ok: true, data: { created: 1, targetYear: 2027 } });
  reorderMock.mockResolvedValue({ ok: true, data: { count: 1 } });
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

  it("クラス単位で裏方クラス（学年名と同名）だけが残る学年は、再利用して学年単位化し createClassAction を呼ばない", async () => {
    // クラス単位⇄学年単位を往復しても同名クラスが孤児として累積しないことの回帰テスト。
    const h = {
      departments: [{ id: "d1", name: "電子工学科", displayOrder: 0 }],
      grades: [
        {
          id: "g-ghost",
          name: "電子工学科2年",
          displayOrder: 0,
          hasClasses: true,
          departmentId: "d1",
          // 残っているのは学年名と同名の裏方クラス 1 つだけ。
          classes: [{ id: "c-ghost", name: "電子工学科2年", academicYear: 2026, grade: 2 }],
        },
      ],
    };
    render(<HierarchyManager hierarchy={h} />);
    fireEvent.click(screen.getByRole("button", { name: "学年の操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "学年単位にする（組に分けない）" }));
    await waitFor(() =>
      expect(updateGradeMock).toHaveBeenCalledWith(
        expect.objectContaining({ id: "g-ghost", hasClasses: false }),
      ),
    );
    // 既存の裏方クラスを再利用するので新規作成しない。
    expect(createClassMock).not.toHaveBeenCalled();
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
      "/app/editor/c1",
    );
  });

  it("一括操作→新年度へ複製→複製する で duplicateClassesToNextYearAction を呼ぶ", async () => {
    render(<HierarchyManager hierarchy={HIERARCHY} />);
    fireEvent.click(screen.getByRole("button", { name: /一括操作/ }));
    fireEvent.click(screen.getByRole("button", { name: "新年度へ複製" }));
    // HIERARCHY のクラスは 2026 年度 → 翌年度 2027 の確認ボタン。
    fireEvent.click(screen.getByRole("button", { name: "2027年度に複製する" }));
    await waitFor(() => expect(dupMock).toHaveBeenCalled());
  });

  it("複製が created:0（冪等 no-op）なら『既に揃っています』を出す", async () => {
    // 再実行で target 年度が既に埋まっている場合、action は成功扱いの created:0 を返す。
    dupMock.mockResolvedValue({ ok: true, data: { created: 0, targetYear: 2027 } });
    render(<HierarchyManager hierarchy={HIERARCHY} />);
    fireEvent.click(screen.getByRole("button", { name: /一括操作/ }));
    fireEvent.click(screen.getByRole("button", { name: "新年度へ複製" }));
    fireEvent.click(screen.getByRole("button", { name: "2027年度に複製する" }));
    await waitFor(() =>
      expect(screen.getByText(/2027年度のクラスは既に揃っています/)).toBeInTheDocument(),
    );
  });
});

describe("RowMenu キーボード a11y（矢印 / Home/End / Esc / トリガ）", () => {
  // クラス行の ⋯ メニューは 2 項目「名称・年度を編集（先頭）」「削除（末尾）」。名前で引いて index 依存を避ける。
  const openClassMenu = () => fireEvent.click(screen.getByRole("button", { name: "クラスの操作" }));
  const firstItem = () => screen.getByRole("menuitem", { name: "名称・年度を編集" });
  const lastItem = () => screen.getByRole("menuitem", { name: "削除" });

  it("開くと先頭 menuitem にフォーカスし、↑↓ で巡回（端で巻き戻し）する", () => {
    render(<HierarchyManager hierarchy={HIERARCHY} />);
    openClassMenu();
    expect(firstItem()).toHaveFocus();
    fireEvent.keyDown(firstItem(), { key: "ArrowDown" });
    expect(lastItem()).toHaveFocus();
    fireEvent.keyDown(lastItem(), { key: "ArrowDown" }); // 末尾→先頭へ巻き戻し
    expect(firstItem()).toHaveFocus();
    fireEvent.keyDown(firstItem(), { key: "ArrowUp" }); // 先頭→末尾へ巻き戻し
    expect(lastItem()).toHaveFocus();
  });

  it("Home/End で先頭・末尾の menuitem へ飛ぶ", () => {
    render(<HierarchyManager hierarchy={HIERARCHY} />);
    openClassMenu();
    fireEvent.keyDown(firstItem(), { key: "End" });
    expect(lastItem()).toHaveFocus();
    fireEvent.keyDown(lastItem(), { key: "Home" });
    expect(firstItem()).toHaveFocus();
  });

  it("Esc でメニューを閉じ、トリガへフォーカスを戻す", () => {
    render(<HierarchyManager hierarchy={HIERARCHY} />);
    const trigger = screen.getByRole("button", { name: "クラスの操作" });
    fireEvent.click(trigger);
    fireEvent.keyDown(firstItem(), { key: "Escape" });
    expect(screen.queryByRole("menuitem")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("トリガ上 ArrowDown でメニューを開き先頭項目へフォーカスする", () => {
    render(<HierarchyManager hierarchy={HIERARCHY} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "クラスの操作" }), { key: "ArrowDown" });
    expect(firstItem()).toHaveFocus();
  });
});

describe("表示順の並べ替え（⋯メニュー 上へ/下へ移動 + ドラッグ&ドロップ）", () => {
  // 学科 2 件（配下なし＝各 section にグリップ 1 つ）。永続化は単一の reorderHierarchyAction（新しい id 列を渡す）。
  const TWO_DEPTS = {
    departments: [
      { id: "d-a", name: "A科", displayOrder: 0 },
      { id: "d-b", name: "B科", displayOrder: 1 },
    ],
    grades: [],
  };
  // 学科 1 + 学年 2（配下クラスなし）。
  const TWO_GRADES = {
    departments: [{ id: "d1", name: "電子工学科", displayOrder: 0 }],
    grades: [
      {
        id: "g-a",
        name: "電子工学科1年",
        displayOrder: 0,
        hasClasses: true,
        departmentId: "d1",
        classes: [],
      },
      {
        id: "g-b",
        name: "電子工学科2年",
        displayOrder: 1,
        hasClasses: true,
        departmentId: "d1",
        classes: [],
      },
    ],
  };
  const sectionOf = (label: string) => {
    const el = screen.getByText(label).closest("section");
    if (!el) throw new Error(`${label} の section が見つかりません`);
    return el;
  };

  it("先頭の学科は ⋯ に「下へ移動」のみ出し、選ぶと新しい並び順で reorderHierarchyAction を呼ぶ", async () => {
    render(<HierarchyManager hierarchy={TWO_DEPTS} />);
    const aMenu = sectionOf("A科");
    fireEvent.click(within(aMenu).getByRole("button", { name: "学科の操作" }));
    // 先頭なので「上へ移動」は出ない。
    expect(within(aMenu).queryByRole("menuitem", { name: "上へ移動" })).toBeNull();
    fireEvent.click(within(aMenu).getByRole("menuitem", { name: "下へ移動" }));
    // A科を下へ → 新しい並び [B科, A科]。displayOrder=0..n-1 への正規化はサーバ側。
    await waitFor(() =>
      expect(reorderMock).toHaveBeenCalledWith({
        entity: "department",
        orderedIds: ["d-b", "d-a"],
      }),
    );
  });

  it("末尾の学科は ⋯ に「下へ移動」を出さない（端の保護）", () => {
    render(<HierarchyManager hierarchy={TWO_DEPTS} />);
    const bMenu = sectionOf("B科");
    fireEvent.click(within(bMenu).getByRole("button", { name: "学科の操作" }));
    expect(within(bMenu).queryByRole("menuitem", { name: "下へ移動" })).toBeNull();
    expect(within(bMenu).getByRole("menuitem", { name: "上へ移動" })).toBeInTheDocument();
  });

  it("学科をドラッグ&ドロップで並べ替えると reorderHierarchyAction(department, 新しい順) を呼ぶ", async () => {
    render(<HierarchyManager hierarchy={TWO_DEPTS} />);
    const aGrip = within(sectionOf("A科")).getByTitle(/ドラッグして並べ替え/);
    const bSection = sectionOf("B科");
    fireEvent.dragStart(aGrip);
    fireEvent.dragOver(bSection);
    fireEvent.drop(bSection);
    await waitFor(() =>
      expect(reorderMock).toHaveBeenCalledWith({
        entity: "department",
        orderedIds: ["d-b", "d-a"],
      }),
    );
  });

  it("学年も ⋯ の「下へ移動」で reorderHierarchyAction(grade, 新しい順) を呼ぶ", async () => {
    render(<HierarchyManager hierarchy={TWO_GRADES} />);
    const menus = screen.getAllByRole("button", { name: "学年の操作" });
    const firstGradeMenu = menus[0];
    if (!firstGradeMenu) throw new Error("学年メニューが見つかりません");
    fireEvent.click(firstGradeMenu);
    fireEvent.click(screen.getByRole("menuitem", { name: "下へ移動" }));
    // 学年は entity="grade"。hasClasses/departmentId はサーバ側が displayOrder のみ更新で保持する。
    await waitFor(() =>
      expect(reorderMock).toHaveBeenCalledWith({ entity: "grade", orderedIds: ["g-b", "g-a"] }),
    );
  });
});
