import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #48-K2: HierarchyManager の編集/削除/一括追加の **UI 配線**検証。Server Action は hub-actions.test.ts
 * で実証済みなので、ここはボタンが正しいアクションを正しい引数で呼ぶことだけ固める（認可/検証/監査は不問）。
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
  createGradeAction,
  deleteClassAction,
  deleteDepartmentAction,
} from "../../lib/school-admin/hub-actions";

const ok = { ok: true as const, data: { id: "x" } };
const createGradeMock = vi.mocked(createGradeAction);
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
  deleteDeptMock.mockResolvedValue(ok);
  deleteClassMock.mockResolvedValue(ok);
});
afterEach(() => vi.restoreAllMocks());

describe("HierarchyManager（編集/削除/一括追加 配線）", () => {
  it("学科・学年・クラスに編集/削除ボタンを出す", () => {
    render(<HierarchyManager hierarchy={HIERARCHY} />);
    // 「電子工学科」は学科行 + 学年追加の学科プルダウン option の双方に出るため getAllByText で見る。
    expect(screen.getAllByText("電子工学科").length).toBeGreaterThan(0);
    expect(screen.getByText("電子工学科3年")).toBeInTheDocument();
    expect(screen.getByText(/1組/)).toBeInTheDocument();
    // 各エンティティに編集/削除が出ている（少なくとも複数）。
    expect(screen.getAllByRole("button", { name: "編集" }).length).toBeGreaterThanOrEqual(3);
    expect(screen.getAllByRole("button", { name: "削除" }).length).toBeGreaterThanOrEqual(3);
  });

  it("学科の削除は確認 → deleteDepartmentAction(id) を呼ぶ", async () => {
    render(<HierarchyManager hierarchy={HIERARCHY} />);
    // 学科行（電子工学科）の削除ボタン = 最初の「削除」。
    fireEvent.click(screen.getAllByRole("button", { name: "削除" })[0]);
    // 確認 UI が出る。
    const confirmBtn = await screen.findByRole("button", { name: "削除する" });
    fireEvent.click(confirmBtn);
    await waitFor(() => expect(deleteDeptMock).toHaveBeenCalledWith("d-elec"));
  });

  it("「全学科に一括追加」は各学科に {学科名}{学年名} を作る", async () => {
    render(<HierarchyManager hierarchy={HIERARCHY} />);
    fireEvent.change(screen.getByPlaceholderText(/学年名（例: 1年）/), {
      target: { value: "1年" },
    });
    fireEvent.click(screen.getByRole("button", { name: "全学科に一括追加" }));
    await waitFor(() => expect(createGradeMock).toHaveBeenCalledTimes(2));
    expect(createGradeMock).toHaveBeenCalledWith({ name: "電子工学科1年", departmentId: "d-elec" });
    expect(createGradeMock).toHaveBeenCalledWith({ name: "機械科1年", departmentId: "d-mech" });
  });

  it("クラスの削除は確認 → deleteClassAction(id) を呼ぶ", async () => {
    render(<HierarchyManager hierarchy={HIERARCHY} />);
    // クラス行（1組）の削除 = 学科1 + 学年1 の後、3 番目の「削除」。
    const dels = screen.getAllByRole("button", { name: "削除" });
    fireEvent.click(dels[dels.length - 1]);
    const confirmBtn = await screen.findByRole("button", { name: "削除する" });
    fireEvent.click(confirmBtn);
    await waitFor(() => expect(deleteClassMock).toHaveBeenCalledWith("c1"));
  });
});
