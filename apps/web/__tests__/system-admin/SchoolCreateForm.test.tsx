import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #48-L3 (#123): SchoolCreateForm の**項目別インライン検証 (FormField)**。createSchoolAction と router を
 * mock し、(1) 空送信は項目の下にエラーを出し action を呼ばない (2) 入力で当該エラーが消える
 * (3) 正常入力で action を反転値で呼び詳細へ push (4) サーバ失敗は上部にエラー、を検証する。
 * 検証規則そのものは schools-core.test.ts (collectSchoolFieldErrors) で固定。
 */

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/lib/system-admin/schools-actions", () => ({ createSchoolAction: vi.fn() }));

import { SchoolCreateForm } from "../../app/ops/schools/new/_components/SchoolCreateForm";
import { createSchoolAction } from "../../lib/system-admin/schools-actions";

const createMock = vi.mocked(createSchoolAction);
const SCHOOL_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("SchoolCreateForm 項目別検証", () => {
  it("空送信は項目の下にエラーを出し、action を呼ばない", () => {
    render(<SchoolCreateForm />);
    fireEvent.click(screen.getByRole("button", { name: "登録する" }));
    expect(createMock).not.toHaveBeenCalled();
    expect(screen.getByText(/学校名は 1〜200 文字/)).toBeInTheDocument();
    expect(screen.getByText(/都道府県は 1〜32 文字/)).toBeInTheDocument();
  });

  it("項目を入力すると当該エラーが消える", () => {
    render(<SchoolCreateForm />);
    fireEvent.click(screen.getByRole("button", { name: "登録する" }));
    expect(screen.getByText(/学校名は 1〜200 文字/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "学校名" }), {
      target: { value: "岐南工業高校" },
    });
    expect(screen.queryByText(/学校名は 1〜200 文字/)).toBeNull();
    // 都道府県のエラーは残る (個別にクリアされる)。
    expect(screen.getByText(/都道府県は 1〜32 文字/)).toBeInTheDocument();
  });

  it("正常入力で createSchoolAction を呼び、詳細ページへ push する", async () => {
    createMock.mockResolvedValue({ ok: true, data: { id: SCHOOL_ID } });
    render(<SchoolCreateForm />);
    fireEvent.change(screen.getByRole("textbox", { name: "学校名" }), {
      target: { value: "岐南工業高校" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "都道府県" }), {
      target: { value: "岐阜県" },
    });
    fireEvent.click(screen.getByRole("button", { name: "登録する" }));
    await waitFor(() =>
      expect(createMock).toHaveBeenCalledWith({
        name: "岐南工業高校",
        prefecture: "岐阜県",
        code: "",
        hierarchyMode: "class",
      }),
    );
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/ops/schools/${SCHOOL_ID}`));
  });

  it("サーバ失敗時は上部にエラーを表示し push しない", async () => {
    createMock.mockResolvedValue({
      ok: false,
      error: { code: "conflict", message: "同名の学校が既に存在します。" },
    });
    render(<SchoolCreateForm />);
    fireEvent.change(screen.getByRole("textbox", { name: "学校名" }), {
      target: { value: "重複校" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "都道府県" }), {
      target: { value: "岐阜県" },
    });
    fireEvent.click(screen.getByRole("button", { name: "登録する" }));
    expect(await screen.findByText("同名の学校が既に存在します。")).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });
});
