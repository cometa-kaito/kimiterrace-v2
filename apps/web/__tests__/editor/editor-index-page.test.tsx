import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * エディタ着地「実画面モニタの壁」(PR・A、#953 `ScaledSignageBoard` 依存) の構造を pin する。
 *
 * 各クラスが実機と同一の payload ビルダー (`buildSignagePayloadForClass`) で組み立てた `SignagePayload` を
 * `ScaledSignageBoard` で縮小描画し、その下に学年ラベル＋状態ドット (緑=本日表示中 / 琥珀=未入力) を出す
 * こと、PC クイック行 (前回再開 / 全クラス一斉)・学科のまとめ出しチップ・各クラスリンク href・前回再開の
 * cookie 突合 (IDOR)・teacher 単一クラス自動直行を検証する。重い盤面 / CSS は `ScaledSignageBoard` を
 * mock して payload の受け渡しだけ確認する (盤面描画自体は signage 側テストの担保領域)。
 *
 * guard / db / hub-queries / signage-display / rotation を mock し、認可と RLS は requireRole + 各ページ +
 * DB が担保するので、ここは UX 層の構造のみ検証する。
 */

vi.mock("../../lib/auth/guard", () => ({ requireRole: vi.fn() }));
vi.mock("../../lib/db", () => ({ withSession: vi.fn() }));
// hub-queries は `@kimiterrace/db`（postgres barrel）を transitively import するため、apps/web の vitest
// 環境では丸ごと mock する（本物の解決は不可。純関数 computeTodayActiveClasses も含め stub 化）。
// computeTodayActiveClasses は scope 集合 → クラス別 active の継承伝搬を行うので、テストでは
// school / classId のみを反映する忠実な簡易版で代用する（学科/学年継承は別 .test.ts の担保領域）。
vi.mock("../../lib/school-admin/hub-queries", () => ({
  getSchoolHierarchy: vi.fn(),
  getTodayDailyDataScopes: vi.fn(),
  computeTodayActiveClasses: vi.fn(
    (scopes: { school: boolean; classIds: string[] }, grades: { classes: { id: string }[] }[]) => {
      const classSet = new Set(scopes.classIds);
      const out: Record<string, boolean> = {};
      for (const g of grades) {
        for (const c of g.classes) {
          out[c.id] = scopes.school || classSet.has(c.id);
        }
      }
      return out;
    },
  ),
}));
// 実画面 payload ビルダー: クラスごとに呼ばれる。中身は ScaledSignageBoard mock に渡るだけ。
vi.mock("../../lib/signage/signage-display", () => ({ buildSignagePayloadForClass: vi.fn() }));
// 着地日付は JST 今日。テストでは固定値に。
vi.mock("../../lib/signage/rotation", () => ({ jstDateString: vi.fn(() => "2026-06-15") }));
// 盤面サムネは payload の受け渡しだけ確認する軽量スタブに差し替える（CSS module / 実描画を避ける）。
vi.mock("../../app/(signage)/signage/[classToken]/_components/ScaledSignageBoard", () => ({
  ScaledSignageBoard: ({ payload }: { payload: { __classId?: string } }) => (
    <div data-testid="scaled-board" data-class={payload.__classId ?? ""} />
  ),
}));
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
import { getSchoolHierarchy, getTodayDailyDataScopes } from "../../lib/school-admin/hub-queries";
import { buildSignagePayloadForClass } from "../../lib/signage/signage-display";
import { redirect } from "next/navigation";

const requireRoleMock = vi.mocked(requireRole);
const withSessionMock = vi.mocked(withSession);
const getSchoolHierarchyMock = vi.mocked(getSchoolHierarchy);
const getTodayDailyDataScopesMock = vi.mocked(getTodayDailyDataScopes);
const buildSignagePayloadMock = vi.mocked(buildSignagePayloadForClass);
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
      classes: [{ id: CLASS_ID, name: "1年A組", grade: 1 }],
    },
  ],
};

const emptyScopes = { school: false, departmentIds: [], gradeIds: [], classIds: [] };

beforeEach(() => {
  vi.clearAllMocks();
  cookieState.lastClass = undefined;
  requireRoleMock.mockResolvedValue({ uid: "u1", role: "school_admin", schoolId: "s1" } as never);
  withSessionMock.mockImplementation(((fn: (tx: unknown) => unknown) =>
    Promise.resolve(fn({}))) as typeof withSession);
  getSchoolHierarchyMock.mockResolvedValue(hierarchy as never);
  getTodayDailyDataScopesMock.mockResolvedValue(emptyScopes as never);
  // payload は classId をタグ付けして返す（ScaledSignageBoard mock がどのクラスのものか判別できるように）。
  buildSignagePayloadMock.mockImplementation(
    (_tx, _schoolId, classId) => Promise.resolve({ __classId: classId }) as never,
  );
});

describe("EditorIndexPage モニタの壁・scope 対象リンク", () => {
  it("全クラス一斉 / 学科まとめ出し / クラスのリンクを正しい href で出し、年度・タイトル見出しは出さない", async () => {
    render(await EditorIndexPage({ searchParams: Promise.resolve({}) }));

    // 「全クラスに一斉表示」(学校 scope) — PC クイック行 + ドロワーの両方に存在しうるので最初の 1 件を見る。
    const broadcastAll = screen.getAllByRole("link", { name: /全クラスに一斉表示/ })[0];
    expect(broadcastAll).toHaveAttribute("href", "/app/editor/scope/school");

    // 学科まとめ出しチップ (department scope)。
    const dept = screen.getByRole("link", { name: /この学科にまとめて出す/ });
    expect(dept).toHaveAttribute("href", `/app/editor/scope/department/${DEPT_ID}`);

    // クラスリンク (本体グリッド)。aria-label でモニタタイル全体がリンクであることを確認。
    const cls = screen.getByRole("link", { name: /1年A組 を編集/ });
    expect(cls).toHaveAttribute("href", `/app/editor/${CLASS_ID}`);

    // タイトル・説明見出しは出さない（承認済みプレビュー準拠）。
    expect(screen.queryByText(/編集するクラスを選ぶ/)).not.toBeInTheDocument();
    expect(screen.queryByText(/編集するモニタを選ぶ/)).not.toBeInTheDocument();
    // 年度（academic_year）表記は一切出さない。
    expect(screen.queryByText(/年度/)).not.toBeInTheDocument();
  });

  it("各クラスの実画面サムネ (ScaledSignageBoard) を実機と同一ビルダーの payload で描く", async () => {
    render(await EditorIndexPage({ searchParams: Promise.resolve({}) }));
    // クラス数ぶん payload ビルダーが呼ばれ、各クラスの classId で呼ばれる（単一ソース・実機一致）。
    expect(buildSignagePayloadMock).toHaveBeenCalledWith({}, "s1", CLASS_ID, "2026-06-15");
    // 盤面サムネが当該クラスの payload を受け取って描画される。
    const boards = screen.getAllByTestId("scaled-board");
    expect(boards.some((b) => b.getAttribute("data-class") === CLASS_ID)).toBe(true);
  });

  it("クラス 0 件でも全クラス一斉リンクは出る (学校全体は常に編集可能)", async () => {
    getSchoolHierarchyMock.mockResolvedValue({ departments: [], grades: [] } as never);
    render(await EditorIndexPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getAllByRole("link", { name: /全クラスに一斉表示/ })[0]).toHaveAttribute(
      "href",
      "/app/editor/scope/school",
    );
  });
});

/**
 * 状態ドット (緑=本日表示中 / 琥珀=未入力)。computeTodayActiveClasses は純関数の本物を使い、
 * getTodayDailyDataScopes の戻りで active/inactive を切り替える。
 */
describe("EditorIndexPage 本日掲示状態ドット", () => {
  it("本日掲示中のクラスは『本日表示中』ラベルを持つ", async () => {
    getTodayDailyDataScopesMock.mockResolvedValue({
      ...emptyScopes,
      classIds: [CLASS_ID],
    } as never);
    render(await EditorIndexPage({ searchParams: Promise.resolve({}) }));
    // 本体タイルの状態ドット（aria-label）。
    expect(screen.getAllByLabelText("本日表示中").length).toBeGreaterThan(0);
  });

  it("未入力のクラスは『未入力』ラベルを持つ", async () => {
    render(await EditorIndexPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getAllByLabelText("未入力").length).toBeGreaterThan(0);
  });
});

/**
 * UIUX-02 ②: 「前回のモニタを再開」cookie 突合の IDOR 検証（許可 + 拒否）。
 *
 * `getSchoolHierarchy` は RLS スコープ済みの自校階層を返す（DB レベルで他校行は不可視）。本ページは
 * cookie の classId を**その自校集合と `===` 突合してから**しかリンク化しない。よって改竄した cookie
 * （他校 ID・非 UUID・インジェクション風）は突合で弾かれ、再開リンクに化けない。
 */
describe("EditorIndexPage 前回モニタ再開（cookie 突合 / IDOR）", () => {
  it("許可: cookie が自校階層内のクラスを指すとき「前回のモニタを再開」を自校 href で出す", async () => {
    cookieState.lastClass = CLASS_ID;
    render(await EditorIndexPage({ searchParams: Promise.resolve({}) }));
    const resume = screen.getAllByRole("link", { name: /前回のモニタを再開/ })[0];
    expect(resume).toHaveAttribute("href", `/app/editor/${CLASS_ID}`);
  });

  it("拒否: cookie が他校/スコープ外のクラス ID でも突合で弾かれ再開リンクを出さない", async () => {
    cookieState.lastClass = OTHER_SCHOOL_CLASS_ID; // 自校 hierarchy に含まれない = RLS スコープ外相当
    render(await EditorIndexPage({ searchParams: Promise.resolve({}) }));
    expect(screen.queryByText(/前回のモニタを再開/)).not.toBeInTheDocument();
    // 自校のクラスリンクだけは従来どおり出る（再開導線だけが抑止される）。
    expect(screen.getByRole("link", { name: /1年A組 を編集/ })).toHaveAttribute(
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
    expect(screen.getAllByRole("link", { name: /全クラスに一斉表示/ })[0]).toBeInTheDocument();
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
            { id: CLASS_ID, name: "1年A組", grade: 1 },
            {
              id: "33333333-3333-4333-8333-333333333333",
              name: "1年B組",
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

/**
 * ドロワー (スマホ横リスト) の最低限の検証。本体ページは Server のまま、ドロワーは client island。
 * 既定は閉じており、ハンバーガーを押すと開いてクイックアクション + 学科ごとのクラス一覧が出る。
 */
describe("EditorIndexPage ハンバーガー → ドロワー（client island）", () => {
  it("既定は閉じており、ハンバーガーを押すとクイックアクションとクラス一覧が開く", async () => {
    render(await EditorIndexPage({ searchParams: Promise.resolve({}) }));

    // 既定: ドロワー (dialog) は閉じている。
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /メニュー/ }));

    const dialog = screen.getByRole("dialog", { name: /モニタ一覧/ });
    // ドロワー内に全クラス一斉と学科まとめ出しとクラス行が出る。
    expect(within(dialog).getByRole("link", { name: /全クラスに一斉表示/ })).toHaveAttribute(
      "href",
      "/app/editor/scope/school",
    );
    expect(within(dialog).getByRole("link", { name: /この学科にまとめて出す/ })).toHaveAttribute(
      "href",
      `/app/editor/scope/department/${DEPT_ID}`,
    );
    // 学年込みラベルでクラス行が出る (年度は出さない)。
    const clsRow = within(dialog).getByRole("link", { name: /1年A組/ });
    expect(clsRow).toHaveAttribute("href", `/app/editor/${CLASS_ID}`);
  });
});
