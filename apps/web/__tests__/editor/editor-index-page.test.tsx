import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * エディタ index「モニタの壁」(2026-06-15) に scope 編集対象が出ることを pin する。
 *
 * 先頭に「全クラスに一斉表示」、各学科見出しに「この学科にまとめて出す」、複数クラスを持つ学年見出しに
 * 「この学年だけまとめて」の放送リンクが正しい `/app/editor/scope/...` href で出ること、既存クラスリンク
 * （＝各モニタ）が維持されることを検証する。guard / db / hub-queries / signage を mock し、
 * `getSchoolHierarchy` の戻りを固定して描画だけ確認する（認可と RLS は requireRole + 各ページ + DB が担保）。
 */

vi.mock("../../lib/auth/guard", () => ({ requireRole: vi.fn() }));
vi.mock("../../lib/db", () => ({ withSession: vi.fn() }));
// モニタの本日状態（getTodayDailyDataScopes + computeTodayActiveClasses）も本ページで読むため mock する。
vi.mock("../../lib/school-admin/hub-queries", () => ({
  getSchoolHierarchy: vi.fn(),
  getTodayDailyDataScopes: vi.fn(),
  computeTodayActiveClasses: vi.fn(() => ({})),
}));
// クラスタイルのパターンバッジ用（学校レベル既定）。本ページは withSession 内で読むため mock 必須。
vi.mock("../../lib/signage/signage-design", () => ({ getSignageDesignPattern: vi.fn() }));
// 「前回のモニタを再開」(UIUX-02) が読む cookie をテストから制御する（既定は未設定）。
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
import {
  computeTodayActiveClasses,
  getSchoolHierarchy,
  getTodayDailyDataScopes,
} from "../../lib/school-admin/hub-queries";
import { getSignageDesignPattern } from "../../lib/signage/signage-design";
import { redirect } from "next/navigation";

const requireRoleMock = vi.mocked(requireRole);
const withSessionMock = vi.mocked(withSession);
const getSchoolHierarchyMock = vi.mocked(getSchoolHierarchy);
const getTodayDailyDataScopesMock = vi.mocked(getTodayDailyDataScopes);
const computeTodayActiveClassesMock = vi.mocked(computeTodayActiveClasses);
const getSignageDesignPatternMock = vi.mocked(getSignageDesignPattern);
const redirectMock = vi.mocked(redirect);

const DEPT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const GRADE_ID = "99999999-9999-4999-8999-999999999999";
const CLASS_ID = "11111111-1111-4111-8111-111111111111";
const CLASS_ID_B = "44444444-4444-4444-8444-444444444444";
const OTHER_SCHOOL_CLASS_ID = "22222222-2222-4222-8222-222222222222";

// 既定: 単一クラス（teacher 自動直行テスト用）。scope リンク網羅テストは別途複数クラスを与える。
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
  getTodayDailyDataScopesMock.mockResolvedValue({
    school: false,
    departmentIds: [],
    gradeIds: [],
    classIds: [],
  } as never);
  computeTodayActiveClassesMock.mockReturnValue({});
  getSignageDesignPatternMock.mockResolvedValue("pattern1" as never);
});

describe("EditorIndexPage scope 対象リンク（放送タイル）", () => {
  it("全クラス一斉 / 学科まとめ / 学年まとめ / 各モニタのリンクを正しい href で出す", async () => {
    // 学年まとめチップは複数クラスの学年にだけ出るため、2 クラスの学年を与えて網羅検証する。
    getSchoolHierarchyMock.mockResolvedValue({
      departments: [{ id: DEPT_ID, name: "電気科", displayOrder: 0 }],
      grades: [
        {
          id: GRADE_ID,
          name: "1年",
          displayOrder: 0,
          hasClasses: true,
          departmentId: DEPT_ID,
          classes: [
            { id: CLASS_ID, name: "1年A組", academicYear: 2026, grade: 1 },
            { id: CLASS_ID_B, name: "1年B組", academicYear: 2026, grade: 1 },
          ],
        },
      ],
    } as never);
    render(await EditorIndexPage({ searchParams: Promise.resolve({}) }));

    const school = screen.getByRole("link", { name: /全クラスに一斉表示/ });
    expect(school).toHaveAttribute("href", "/app/editor/scope/school");

    const dept = screen.getByRole("link", { name: /この学科にまとめて出す/ });
    expect(dept).toHaveAttribute("href", `/app/editor/scope/department/${DEPT_ID}`);

    const grade = screen.getByRole("link", { name: /この学年だけまとめて/ });
    expect(grade).toHaveAttribute("href", `/app/editor/scope/grade/${GRADE_ID}`);

    // 既存クラスリンク（＝各モニタ）は維持される。
    expect(screen.getByRole("link", { name: /1年A組/ })).toHaveAttribute(
      "href",
      `/app/editor/${CLASS_ID}`,
    );
    expect(screen.getByRole("link", { name: /1年B組/ })).toHaveAttribute(
      "href",
      `/app/editor/${CLASS_ID_B}`,
    );

    // 範囲の概念（共通＝まとめて一斉表示・クラス個別が優先）を 1 行で説明する。
    expect(screen.getByText(/まとめて一斉表示（個別入力が優先）/)).toBeInTheDocument();
  });

  it("単一クラスの学年には「この学年だけまとめて」を出さない（クラス編集と冗長なため）", async () => {
    render(await EditorIndexPage({ searchParams: Promise.resolve({}) }));
    expect(screen.queryByRole("link", { name: /この学年だけまとめて/ })).not.toBeInTheDocument();
    // 学科まとめ・全クラス一斉は単一クラスでも出る。
    expect(screen.getByRole("link", { name: /この学科にまとめて出す/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /全クラスに一斉表示/ })).toBeInTheDocument();
  });

  it("クラス 0 件でも全クラス一斉リンクは出る (学校全体は常に編集可能)", async () => {
    getSchoolHierarchyMock.mockResolvedValue({ departments: [], grades: [] } as never);
    render(await EditorIndexPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole("link", { name: /全クラスに一斉表示/ })).toHaveAttribute(
      "href",
      "/app/editor/scope/school",
    );
  });
});

/**
 * UIUX-02 ②: 「前回のモニタを再開」cookie 突合の IDOR 検証（許可 + 拒否）。
 *
 * `getSchoolHierarchy` は RLS スコープ済みの自校階層を返す（DB レベルで他校行は不可視）。本ページは
 * cookie の classId を**その自校集合と `===` 突合してから**しかリンク化しない。よって改竄した cookie
 * （他校 ID・非 UUID・インジェクション風）は突合で弾かれ、再開リンクに化けない。さらに遷移先
 * `[classId]/page.tsx` も独立に RLS で 404 化する（多層防御・別テストの担保領域）。
 */
describe("EditorIndexPage 前回モニタ再開（cookie 突合 / IDOR）", () => {
  it("許可: cookie が自校階層内のクラスを指すとき「前回のモニタを再開」を自校 href で出す", async () => {
    cookieState.lastClass = CLASS_ID;
    render(await EditorIndexPage({ searchParams: Promise.resolve({}) }));
    const resume = screen.getByRole("link", { name: /前回のモニタを再開/ });
    expect(resume).toHaveAttribute("href", `/app/editor/${CLASS_ID}`);
  });

  it("拒否: cookie が他校/スコープ外のクラス ID でも突合で弾かれ再開リンクを出さない", async () => {
    cookieState.lastClass = OTHER_SCHOOL_CLASS_ID; // 自校 hierarchy に含まれない = RLS スコープ外相当
    render(await EditorIndexPage({ searchParams: Promise.resolve({}) }));
    expect(screen.queryByText(/前回のモニタを再開/)).not.toBeInTheDocument();
    // 自校のクラスリンクだけは従来どおり出る（再開導線だけが抑止される）。
    expect(screen.getByRole("link", { name: /1年A組/ })).toHaveAttribute(
      "href",
      `/app/editor/${CLASS_ID}`,
    );
  });

  it("拒否: 改竄された非 UUID/インジェクション風 cookie でも例外を出さず無視する", async () => {
    cookieState.lastClass = "'; DROP TABLE classes;--";
    render(await EditorIndexPage({ searchParams: Promise.resolve({}) }));
    expect(screen.queryByText(/前回のモニタを再開/)).not.toBeInTheDocument();
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
    expect(screen.getByRole("link", { name: /全クラスに一斉表示/ })).toBeInTheDocument();
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
