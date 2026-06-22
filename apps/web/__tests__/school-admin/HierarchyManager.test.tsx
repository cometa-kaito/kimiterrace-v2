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
  createOtherLocationAction: vi.fn(),
  updateOtherLocationAction: vi.fn(),
  reorderHierarchyAction: vi.fn(),
}));

import { HierarchyManager } from "../../app/app/school/_components/HierarchyManager";
import {
  createClassAction,
  createGradeAction,
  createOtherLocationAction,
  deleteClassAction,
  deleteDepartmentAction,
  reorderHierarchyAction,
  updateDepartmentAction,
  updateGradeAction,
  updateOtherLocationAction,
} from "../../lib/school-admin/hub-actions";

const ok = { ok: true as const, data: { id: "x" } };
const createGradeMock = vi.mocked(createGradeAction);
const createClassMock = vi.mocked(createClassAction);
const updateGradeMock = vi.mocked(updateGradeAction);
const updateDeptMock = vi.mocked(updateDepartmentAction);
const deleteDeptMock = vi.mocked(deleteDepartmentAction);
const deleteClassMock = vi.mocked(deleteClassAction);
const reorderMock = vi.mocked(reorderHierarchyAction);
const createOtherMock = vi.mocked(createOtherLocationAction);
const updateOtherMock = vi.mocked(updateOtherLocationAction);

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
      classes: [{ id: "c1", name: "1組", grade: 3 }],
    },
  ],
  otherLocations: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  createGradeMock.mockResolvedValue(ok);
  createClassMock.mockResolvedValue(ok);
  updateGradeMock.mockResolvedValue(ok);
  updateDeptMock.mockResolvedValue(ok);
  deleteDeptMock.mockResolvedValue(ok);
  deleteClassMock.mockResolvedValue(ok);
  reorderMock.mockResolvedValue({ ok: true, data: { count: 1 } });
  createOtherMock.mockResolvedValue(ok);
  updateOtherMock.mockResolvedValue(ok);
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
      otherLocations: [],
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
          classes: [{ id: "c-ghost", name: "電子工学科2年", grade: 2 }],
        },
      ],
      otherLocations: [],
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
      otherLocations: [],
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
          classes: [{ id: "cu", name: "電子工学科2年", grade: 2 }],
        },
      ],
      otherLocations: [],
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
});

describe("RowMenu キーボード a11y（矢印 / Home/End / Esc / トリガ）", () => {
  // クラス行の ⋯ メニューは 2 項目「名称を編集（先頭）」「削除（末尾）」。名前で引いて index 依存を避ける。
  const openClassMenu = () => fireEvent.click(screen.getByRole("button", { name: "クラスの操作" }));
  const firstItem = () => screen.getByRole("menuitem", { name: "名称を編集" });
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
    otherLocations: [],
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
    otherLocations: [],
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

/**
 * system_admin が /ops/schools/[id]/hierarchy から特定校を編集する経路。`schoolId` prop を渡すと、
 * すべての Server Action 呼び出しに対象校 id が**末尾引数**として結ばれる (PR1 の targetSchoolId)。
 * school_admin (/app/school、schoolId 未指定) は素の action のまま (上の既存テスト群が回帰を担保)。
 */
describe("対象校スコープ (schoolId prop / system_admin /ops 経路)", () => {
  const SID = "55555555-5555-4555-8555-555555555555";

  it("heading prop を見出しに表示する", () => {
    render(
      <HierarchyManager hierarchy={HIERARCHY} schoolId={SID} heading="クラス設定 — 岐阜農林" />,
    );
    expect(screen.getByRole("heading", { name: "クラス設定 — 岐阜農林" })).toBeInTheDocument();
  });

  it("削除アクションを対象校 id 付き deleteDepartmentAction(id, schoolId) で呼ぶ", async () => {
    render(<HierarchyManager hierarchy={HIERARCHY} schoolId={SID} />);
    const mech = screen.getByText("機械科").closest("section");
    if (!mech) throw new Error("機械科ノードが見つかりません");
    fireEvent.click(within(mech).getByRole("button", { name: "学科の操作" }));
    fireEvent.click(within(mech).getByRole("menuitem", { name: "削除" }));
    fireEvent.click(within(mech).getByRole("button", { name: "削除する" }));
    await waitFor(() => expect(deleteDeptMock).toHaveBeenCalledWith("d-mech", SID));
  });

  it("一括追加も対象校 id 付き createGradeAction(raw, schoolId) で呼ぶ", async () => {
    render(<HierarchyManager hierarchy={HIERARCHY} schoolId={SID} />);
    fireEvent.click(screen.getByRole("button", { name: /一括操作/ }));
    fireEvent.change(screen.getByPlaceholderText("学年名（例: 1年）"), {
      target: { value: "1年" },
    });
    fireEvent.click(screen.getByRole("button", { name: "全学科に一括追加" }));
    await waitFor(() => expect(createGradeMock).toHaveBeenCalledTimes(2));
    expect(createGradeMock).toHaveBeenCalledWith(
      { name: "電子工学科1年", departmentId: "d-elec" },
      SID,
    );
  });

  it("reorder も対象校 id 付き reorderHierarchyAction(raw, schoolId) で呼ぶ", async () => {
    const TWO_DEPTS = {
      departments: [
        { id: "d-a", name: "A科", displayOrder: 0 },
        { id: "d-b", name: "B科", displayOrder: 1 },
      ],
      grades: [],
      otherLocations: [],
    };
    render(<HierarchyManager hierarchy={TWO_DEPTS} schoolId={SID} />);
    const aMenu = screen.getByText("A科").closest("section");
    if (!aMenu) throw new Error("A科 section が見つかりません");
    fireEvent.click(within(aMenu).getByRole("button", { name: "学科の操作" }));
    fireEvent.click(within(aMenu).getByRole("menuitem", { name: "下へ移動" }));
    await waitFor(() =>
      expect(reorderMock).toHaveBeenCalledWith(
        { entity: "department", orderedIds: ["d-b", "d-a"] },
        SID,
      ),
    );
  });
});

/**
 * PR3「その他」(非教室の設置場所 = grade_id NULL クラス) の UI 配線。学校直下 (departmentId NULL) は
 * ツリー上位のセクション、各学科配下 (departmentId=学科) は学科ノード内のサブセクション。作成は
 * createOtherLocationAction、改名は updateOtherLocationAction、削除は deleteClassAction を流用する。
 * Server Action 自体は hub-actions.test.ts で実証済みなので、ここは「正しいアクションを正しい引数で呼ぶ」
 * ことだけ固める。
 */
describe("その他（非教室の設置場所）配線", () => {
  // 学科あり校 + 学校直下「玄関」+ 電子工学科配下「実習棟ホール」。
  const WITH_OTHERS = {
    departments: [{ id: "d-elec", name: "電子工学科", displayOrder: 0 }],
    grades: [
      {
        id: "g1",
        name: "電子工学科3年",
        displayOrder: 0,
        hasClasses: true,
        departmentId: "d-elec",
        classes: [{ id: "c1", name: "1組", grade: 3 }],
      },
    ],
    otherLocations: [
      { id: "o-genkan", name: "玄関", departmentId: null },
      { id: "o-hall", name: "実習棟ホール", departmentId: "d-elec" },
    ],
  };

  it("学校直下・各学科配下に「その他」セクションと既存設置場所を出す", () => {
    render(<HierarchyManager hierarchy={WITH_OTHERS} />);
    expect(screen.getByText("その他（非教室の設置場所）")).toBeInTheDocument();
    expect(screen.getByText("その他（この学科の設置場所）")).toBeInTheDocument();
    expect(screen.getByText("玄関")).toBeInTheDocument();
    expect(screen.getByText("実習棟ホール")).toBeInTheDocument();
  });

  it("学校直下に追加すると createOtherLocationAction({name, departmentId: undefined}) を呼ぶ", async () => {
    render(<HierarchyManager hierarchy={WITH_OTHERS} />);
    // 学校直下の「その他」セクションに絞って「設置場所を追加」する（曖昧な「この学科に追加」を廃止）。
    const schoolSection = screen.getByText("その他（非教室の設置場所）").closest("section");
    if (!schoolSection) throw new Error("学校直下のその他セクションが見つかりません");
    // 追加フォームは既定で畳まれている（v2-sch-ai2）。まず「設置場所を追加」で開く。
    fireEvent.click(within(schoolSection).getByRole("button", { name: "設置場所を追加" }));
    fireEvent.change(within(schoolSection).getByPlaceholderText(/設置場所名/), {
      target: { value: "職員室前" },
    });
    fireEvent.click(within(schoolSection).getByRole("button", { name: "設置場所を追加" }));
    await waitFor(() =>
      expect(createOtherMock).toHaveBeenCalledWith({ name: "職員室前", departmentId: undefined }),
    );
  });

  it("学科配下に追加すると createOtherLocationAction({name, departmentId: 学科id}) を呼ぶ", async () => {
    render(<HierarchyManager hierarchy={WITH_OTHERS} />);
    // 学科ノード内の「設置場所を追加」（学年追加は別ボタン「学年を追加」と明確に分離した）。
    const hallSection = screen.getByText("その他（この学科の設置場所）").closest("section");
    if (!hallSection) throw new Error("学科配下のその他セクションが見つかりません");
    // 追加フォームは既定で畳まれている（v2-sch-ai2）。まず「設置場所を追加」で開く。
    fireEvent.click(within(hallSection).getByRole("button", { name: "設置場所を追加" }));
    fireEvent.change(within(hallSection).getByPlaceholderText(/設置場所名/), {
      target: { value: "廊下" },
    });
    fireEvent.click(within(hallSection).getByRole("button", { name: "設置場所を追加" }));
    await waitFor(() =>
      expect(createOtherMock).toHaveBeenCalledWith({ name: "廊下", departmentId: "d-elec" }),
    );
  });

  it("⋯→名称を編集→保存で updateOtherLocationAction(id, name, 現departmentId) を呼ぶ", async () => {
    render(<HierarchyManager hierarchy={WITH_OTHERS} />);
    const row = screen.getByText("玄関").closest("div");
    if (!row) throw new Error("玄関の行が見つかりません");
    fireEvent.click(within(row).getByRole("button", { name: "設置場所の操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "名称を編集" }));
    const input = screen.getByLabelText("設置場所名");
    fireEvent.change(input, { target: { value: "正面玄関" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      // 学校直下なので departmentId は undefined（null ?? undefined）。
      expect(updateOtherMock).toHaveBeenCalledWith({
        id: "o-genkan",
        name: "正面玄関",
        departmentId: undefined,
      }),
    );
  });

  it("⋯→削除→確認で deleteClassAction(id) を呼ぶ（末端ゆえガードなし）", async () => {
    render(<HierarchyManager hierarchy={WITH_OTHERS} />);
    const row = screen.getByText("実習棟ホール").closest("div");
    if (!row) throw new Error("実習棟ホールの行が見つかりません");
    fireEvent.click(within(row).getByRole("button", { name: "設置場所の操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "削除" }));
    fireEvent.click(screen.getByRole("button", { name: "削除する" }));
    await waitFor(() => expect(deleteClassMock).toHaveBeenCalledWith("o-hall"));
  });

  it("設置場所にも statusByClass で公開中 / エディタ導線を出す", () => {
    render(<HierarchyManager hierarchy={WITH_OTHERS} statusByClass={{ "o-genkan": true }} />);
    expect(screen.getByText("公開中")).toBeInTheDocument();
    const genkanRow = screen.getByText("玄関").closest("div");
    if (!genkanRow) throw new Error("玄関の行が見つかりません");
    expect(within(genkanRow).getByRole("link", { name: "エディタ" })).toHaveAttribute(
      "href",
      "/app/editor/o-genkan",
    );
  });

  it("学科なし校でも学校直下の「その他」を出す", () => {
    const NO_DEPT = {
      departments: [],
      grades: [
        {
          id: "g1",
          name: "1年",
          displayOrder: 0,
          hasClasses: true,
          departmentId: null,
          classes: [{ id: "c1", name: "1組", grade: 1 }],
        },
      ],
      otherLocations: [{ id: "o-genkan", name: "玄関", departmentId: null }],
    };
    render(<HierarchyManager hierarchy={NO_DEPT} />);
    expect(screen.getByText("その他（非教室の設置場所）")).toBeInTheDocument();
    expect(screen.getByText("玄関")).toBeInTheDocument();
  });

  it("対象校スコープ: schoolId 付きで createOtherLocationAction(raw, schoolId) を呼ぶ", async () => {
    const SID = "55555555-5555-4555-8555-555555555555";
    render(<HierarchyManager hierarchy={WITH_OTHERS} schoolId={SID} />);
    const schoolSection = screen.getByText("その他（非教室の設置場所）").closest("section");
    if (!schoolSection) throw new Error("学校直下のその他セクションが見つかりません");
    // 追加フォームは既定で畳まれている（v2-sch-ai2）。まず「設置場所を追加」で開く。
    fireEvent.click(within(schoolSection).getByRole("button", { name: "設置場所を追加" }));
    fireEvent.change(within(schoolSection).getByPlaceholderText(/設置場所名/), {
      target: { value: "体育館前" },
    });
    fireEvent.click(within(schoolSection).getByRole("button", { name: "設置場所を追加" }));
    await waitFor(() =>
      expect(createOtherMock).toHaveBeenCalledWith(
        { name: "体育館前", departmentId: undefined },
        SID,
      ),
    );
  });
});

// UX テスト用: 学科 + 学年 + 学校直下/学科配下の設置場所を持つ階層。
const WITH_OTHERS_FOR_UX = {
  departments: [{ id: "d-elec", name: "電子工学科", displayOrder: 0 }],
  grades: [
    {
      id: "g1",
      name: "電子工学科3年",
      displayOrder: 0,
      hasClasses: true,
      departmentId: "d-elec",
      classes: [{ id: "c1", name: "1組", grade: 3 }],
    },
  ],
  otherLocations: [
    { id: "o-genkan", name: "玄関", departmentId: null },
    { id: "o-hall", name: "実習棟ホール", departmentId: "d-elec" },
  ],
};

/**
 * UX 発見（v2 LEDGER 2026-06-21）の引き算 / 明確化 / 数字表示順廃止の回帰ガード。
 */
describe("UX 改善（引き算・明確化・表示順のドラッグ化）", () => {
  it("掲示が無い行に「本日 掲示なし」を出さない（v2-sch-uo3）", () => {
    // statusByClass を渡さない＝全クラスが掲示なし。何も出さないのが正。
    render(<HierarchyManager hierarchy={HIERARCHY} />);
    expect(screen.queryByText(/掲示なし/)).toBeNull();
  });

  it("重複ヒント「組がなければ空欄でOK…」を各学年に繰り返さない（v2-sch-ai1）", () => {
    render(<HierarchyManager hierarchy={HIERARCHY} />);
    expect(screen.queryByText(/組がなければ空欄でOK/)).toBeNull();
  });

  it("設置場所の冗長な説明文「玄関・廊下…」を出さない（v2-sch-uo4）", () => {
    render(<HierarchyManager hierarchy={HIERARCHY} />);
    expect(screen.queryByText(/玄関・廊下・職員室前/)).toBeNull();
  });

  it("トップの「学科 → 学年 → クラスで校内の構成を管理します」説明を出さない（v2-sch-uo6）", () => {
    render(<HierarchyManager hierarchy={HIERARCHY} />);
    expect(screen.queryByText(/校内の構成を管理します/)).toBeNull();
  });

  it("学科配下の追加は「学年を追加」「設置場所を追加」で対象を明示する（v2-sch-ai3）", () => {
    render(<HierarchyManager hierarchy={WITH_OTHERS_FOR_UX} />);
    // 曖昧な「この学科に追加」は消えている。
    expect(screen.queryByRole("button", { name: "この学科に追加" })).toBeNull();
    expect(screen.getByRole("button", { name: "学年を追加" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "設置場所を追加" }).length).toBeGreaterThan(0);
  });

  it("学年の掲示単位バッジを「組ごとに掲示 / 学年でまとめて掲示」で説明する（v2-sch-ai5）", () => {
    render(<HierarchyManager hierarchy={HIERARCHY} />);
    // HIERARCHY の学年は hasClasses=true。
    expect(screen.getByText("組ごとに掲示")).toBeInTheDocument();
    expect(screen.queryByText("クラス単位")).toBeNull();
  });

  it("名称編集は表示順を数字入力させず、現在の displayOrder を保持して保存する（v2-sch-uo5/回帰）", async () => {
    // displayOrder=2 の学科を名称だけ編集 → updateDepartmentAction に displayOrder:2 が保たれる
    // （数字入力欄を撤去した結果、null 渡し→0 リセットになる回帰を防ぐ）。
    const h = {
      departments: [{ id: "d-x", name: "情報科", displayOrder: 2 }],
      grades: [],
      otherLocations: [],
    };
    render(<HierarchyManager hierarchy={h} />);
    fireEvent.click(screen.getByRole("button", { name: "学科の操作" }));
    // 「名称・表示順を編集」→「名称を編集」に変わっている。
    expect(screen.queryByRole("menuitem", { name: "名称・表示順を編集" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "名称を編集" }));
    // 表示順の数字入力欄は無い。
    expect(screen.queryByLabelText("表示順")).toBeNull();
    fireEvent.change(screen.getByLabelText("学科名"), { target: { value: "情報技術科" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(updateDeptMock).toHaveBeenCalledWith({
        id: "d-x",
        name: "情報技術科",
        displayOrder: 2,
      }),
    );
  });

  it("既存ノードへの追加欄は既定で畳み、「＋ 追加」を押すと開く（v2-sch-ai2）", () => {
    // HIERARCHY の学年 g1 はクラス（1組）を持つので、組の追加フォームは既定で畳まれる。
    render(<HierarchyManager hierarchy={HIERARCHY} />);
    // 平常時は入力欄を出さない（大規模校でのページ激長・密度過多を防ぐ）。
    expect(screen.queryByPlaceholderText(/クラス名/)).toBeNull();
    // 「組を追加」を押すと入力欄が現れる。
    fireEvent.click(screen.getByRole("button", { name: "組を追加" }));
    expect(screen.getByPlaceholderText(/クラス名/)).toBeInTheDocument();
  });
});
