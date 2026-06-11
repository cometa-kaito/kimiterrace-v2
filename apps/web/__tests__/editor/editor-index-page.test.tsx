import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * エディタ index ツリー (段A-2) に scope 編集対象が出ることを pin する。
 *
 * 先頭に「学校全体」、各学科見出しに「学科全体」、各学年見出しに「学年全体」の編集リンクが
 * 正しい `/admin/editor/scope/...` href で出ること、既存クラスリンクが維持されることを検証する。
 * guard / db / hub-queries を mock し、`getSchoolHierarchy` の戻りを固定して描画だけ確認する
 * (認可と RLS は requireRole + 各ページ + DB が担保、ここは UX 層)。
 */

vi.mock("../../lib/auth/guard", () => ({ requireRole: vi.fn() }));
vi.mock("../../lib/db", () => ({ withSession: vi.fn() }));
vi.mock("../../lib/school-admin/hub-queries", () => ({ getSchoolHierarchy: vi.fn() }));
// 「前回のクラスを再開」(UIUX-02) が読む cookie。リクエストスコープ外で throw しないよう空 cookie を返す。
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: () => undefined })),
}));

import EditorIndexPage from "../../app/admin/editor/page";
import { requireRole } from "../../lib/auth/guard";
import { withSession } from "../../lib/db";
import { getSchoolHierarchy } from "../../lib/school-admin/hub-queries";

const requireRoleMock = vi.mocked(requireRole);
const withSessionMock = vi.mocked(withSession);
const getSchoolHierarchyMock = vi.mocked(getSchoolHierarchy);

const DEPT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const GRADE_ID = "99999999-9999-4999-8999-999999999999";
const CLASS_ID = "11111111-1111-4111-8111-111111111111";

const hierarchy = {
  departments: [{ id: DEPT_ID, name: "電気科", displayOrder: 0 }],
  grades: [
    {
      id: GRADE_ID,
      name: "1年",
      displayOrder: 0,
      hasClasses: true,
      departmentId: DEPT_ID,
      classes: [{ id: CLASS_ID, name: "1年A組", academicYear: 2026, grade: 1 }],
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  requireRoleMock.mockResolvedValue({ uid: "u1", role: "school_admin", schoolId: "s1" } as never);
  withSessionMock.mockImplementation(((fn: (tx: unknown) => unknown) =>
    Promise.resolve(fn({}))) as typeof withSession);
  getSchoolHierarchyMock.mockResolvedValue(hierarchy as never);
});

describe("EditorIndexPage scope 対象リンク", () => {
  it("学校全体 / 学科全体 / 学年全体 / クラスのリンクを正しい href で出す", async () => {
    render(await EditorIndexPage({ searchParams: Promise.resolve({}) }));

    const school = screen.getByRole("link", { name: "学校全体の共通を編集" });
    expect(school).toHaveAttribute("href", "/admin/editor/scope/school");

    const dept = screen.getByRole("link", { name: "この学科の共通を編集" });
    expect(dept).toHaveAttribute("href", `/admin/editor/scope/department/${DEPT_ID}`);

    const grade = screen.getByRole("link", { name: "この学年の共通を編集" });
    expect(grade).toHaveAttribute("href", `/admin/editor/scope/grade/${GRADE_ID}`);

    // 既存クラスリンクは維持される。
    const cls = screen.getByRole("link", { name: /1年A組/ });
    expect(cls).toHaveAttribute("href", `/admin/editor/${CLASS_ID}`);

    // 分かりやすさ改善: 範囲の概念（共通は配下の全クラスに表示・クラス個別が優先）を説明する。
    expect(screen.getByText(/範囲を選んで/)).toBeInTheDocument();
    expect(screen.getByText(/優先順位: クラス ＞ 学年 ＞ 学科 ＞ 学校全体/)).toBeInTheDocument();
  });

  it("クラス 0 件でも学校全体リンクは出る (学校全体は常に編集可能)", async () => {
    getSchoolHierarchyMock.mockResolvedValue({ departments: [], grades: [] } as never);
    render(await EditorIndexPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole("link", { name: "学校全体の共通を編集" })).toHaveAttribute(
      "href",
      "/admin/editor/scope/school",
    );
  });
});
