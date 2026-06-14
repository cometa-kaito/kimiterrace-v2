import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * エディタ index ツリー (段A-2) に scope 編集対象が出ることを pin する。
 *
 * 先頭に「学校全体」、各学科見出しに「学科全体」、各学年見出しに「学年全体」の編集リンクが
 * 正しい `/app/editor/scope/...` href で出ること、既存クラスリンクが維持されることを検証する。
 * guard / db / hub-queries を mock し、`getSchoolHierarchy` の戻りを固定して描画だけ確認する
 * (認可と RLS は requireRole + 各ページ + DB が担保、ここは UX 層)。
 */

vi.mock("../../lib/auth/guard", () => ({ requireRole: vi.fn() }));
vi.mock("../../lib/db", () => ({ withSession: vi.fn() }));
vi.mock("../../lib/school-admin/hub-queries", () => ({ getSchoolHierarchy: vi.fn() }));
// 「前回のクラスを再開」(UIUX-02) が読む cookie をテストから制御する（既定は未設定）。
const cookieState = vi.hoisted(() => ({ lastClass: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) =>
      name === "kt_last_class" && cookieState.lastClass
        ? { value: cookieState.lastClass }
        : undefined,
  })),
}));
// 単一クラス teacher の自動直行を検証するため redirect を捕捉する（本物は throw で描画を止める）。
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

import EditorIndexPage from "../../app/app/editor/page";
import { requireRole } from "../../lib/auth/guard";
import { withSession } from "../../lib/db";
import { getSchoolHierarchy } from "../../lib/school-admin/hub-queries";
import { redirect } from "next/navigation";

const requireRoleMock = vi.mocked(requireRole);
const withSessionMock = vi.mocked(withSession);
const getSchoolHierarchyMock = vi.mocked(getSchoolHierarchy);
const redirectMock = vi.mocked(redirect);

const DEPT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const GRADE_ID = "99999999-9999-4999-8999-999999999999";
const CLASS_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_SCHOOL_CLASS_ID = "22222222-2222-4222-8222-222222222222";

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
  cookieState.lastClass = undefined;
  requireRoleMock.mockResolvedValue({ uid: "u1", role: "school_admin", schoolId: "s1" } as never);
  withSessionMock.mockImplementation(((fn: (tx: unknown) => unknown) =>
    Promise.resolve(fn({}))) as typeof withSession);
  getSchoolHierarchyMock.mockResolvedValue(hierarchy as never);
});

describe("EditorIndexPage scope 対象リンク", () => {
  it("学校全体 / 学科全体 / 学年全体 / クラスのリンクを正しい href で出す", async () => {
    render(await EditorIndexPage({ searchParams: Promise.resolve({}) }));

    const school = screen.getByRole("link", { name: "学校全体の共通を編集" });
    expect(school).toHaveAttribute("href", "/app/editor/scope/school");

    const dept = screen.getByRole("link", { name: "この学科の共通を編集" });
    expect(dept).toHaveAttribute("href", `/app/editor/scope/department/${DEPT_ID}`);

    const grade = screen.getByRole("link", { name: "この学年の共通を編集" });
    expect(grade).toHaveAttribute("href", `/app/editor/scope/grade/${GRADE_ID}`);

    // 既存クラスリンクは維持される。
    const cls = screen.getByRole("link", { name: /1年A組/ });
    expect(cls).toHaveAttribute("href", `/app/editor/${CLASS_ID}`);

    // 分かりやすさ改善: 範囲の概念（共通は配下の全クラスに表示・クラス個別が優先）を説明する。
    expect(screen.getByText(/範囲を選んで/)).toBeInTheDocument();
    expect(screen.getByText(/優先順位: クラス ＞ 学年 ＞ 学科 ＞ 学校全体/)).toBeInTheDocument();
  });

  it("クラス 0 件でも学校全体リンクは出る (学校全体は常に編集可能)", async () => {
    getSchoolHierarchyMock.mockResolvedValue({ departments: [], grades: [] } as never);
    render(await EditorIndexPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole("link", { name: "学校全体の共通を編集" })).toHaveAttribute(
      "href",
      "/app/editor/scope/school",
    );
  });
});

/**
 * UIUX-02 ②: 「前回のクラスを再開」cookie 突合の IDOR 検証（許可 + 拒否）。
 *
 * `getSchoolHierarchy` は RLS スコープ済みの自校階層を返す（DB レベルで他校行は不可視）。本ページは
 * cookie の classId を**その自校集合と `===` 突合してから**しかリンク化しない。よって改竄した cookie
 * （他校 ID・非 UUID・インジェクション風）は突合で弾かれ、再開リンクに化けない。さらに遷移先
 * `[classId]/page.tsx` も独立に RLS で 404 化する（多層防御・別テストの担保領域）。
 */
describe("EditorIndexPage 前回クラス再開（cookie 突合 / IDOR）", () => {
  it("許可: cookie が自校階層内のクラスを指すとき「前回のクラスを再開」を自校 href で出す", async () => {
    cookieState.lastClass = CLASS_ID;
    render(await EditorIndexPage({ searchParams: Promise.resolve({}) }));
    const resume = screen.getByRole("link", { name: /前回のクラスを再開/ });
    expect(resume).toHaveAttribute("href", `/app/editor/${CLASS_ID}`);
  });

  it("拒否: cookie が他校/スコープ外のクラス ID でも突合で弾かれ再開リンクを出さない", async () => {
    cookieState.lastClass = OTHER_SCHOOL_CLASS_ID; // 自校 hierarchy に含まれない = RLS スコープ外相当
    render(await EditorIndexPage({ searchParams: Promise.resolve({}) }));
    expect(screen.queryByText(/前回のクラスを再開/)).not.toBeInTheDocument();
    // 自校のクラスリンクだけは従来どおり出る（再開導線だけが抑止される）。
    expect(screen.getByRole("link", { name: /1年A組/ })).toHaveAttribute(
      "href",
      `/app/editor/${CLASS_ID}`,
    );
  });

  it("拒否: 改竄された非 UUID/インジェクション風 cookie でも例外を出さず無視する", async () => {
    cookieState.lastClass = "'; DROP TABLE classes;--";
    render(await EditorIndexPage({ searchParams: Promise.resolve({}) }));
    expect(screen.queryByText(/前回のクラスを再開/)).not.toBeInTheDocument();
  });
});

/**
 * UIUX-02 ①: 単一クラス teacher の自動直行と ?stay=1 によるループ防止。
 */
describe("EditorIndexPage 単一クラス teacher の自動直行（?stay ループ防止）", () => {
  beforeEach(() => {
    requireRoleMock.mockResolvedValue({ uid: "t1", role: "teacher", schoolId: "s1" } as never);
  });

  it("teacher・単一クラス・stay 無しは /app/editor/<id> へ自動 redirect する", async () => {
    await expect(EditorIndexPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      `NEXT_REDIRECT:/app/editor/${CLASS_ID}`,
    );
    expect(redirectMock).toHaveBeenCalledWith(`/app/editor/${CLASS_ID}`);
  });

  it("?stay=1 なら自動 redirect せず選択画面に留まる（無限ループ防止）", async () => {
    render(await EditorIndexPage({ searchParams: Promise.resolve({ stay: "1" }) }));
    expect(redirectMock).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "学校全体の共通を編集" })).toBeInTheDocument();
  });

  it("複数クラスなら（stay 無しでも）自動 redirect しない", async () => {
    getSchoolHierarchyMock.mockResolvedValue({
      departments: [],
      grades: [
        {
          id: GRADE_ID,
          name: "1年",
          displayOrder: 0,
          hasClasses: true,
          departmentId: null,
          classes: [
            { id: CLASS_ID, name: "1年A組", academicYear: 2026, grade: 1 },
            {
              id: "33333333-3333-4333-8333-333333333333",
              name: "1年B組",
              academicYear: 2026,
              grade: 1,
            },
          ],
        },
      ],
    } as never);
    render(await EditorIndexPage({ searchParams: Promise.resolve({}) }));
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("school_admin は単一クラスでも自動 redirect しない（共通編集を使うため）", async () => {
    requireRoleMock.mockResolvedValue({ uid: "u1", role: "school_admin", schoolId: "s1" } as never);
    render(await EditorIndexPage({ searchParams: Promise.resolve({}) }));
    expect(redirectMock).not.toHaveBeenCalled();
  });
});
