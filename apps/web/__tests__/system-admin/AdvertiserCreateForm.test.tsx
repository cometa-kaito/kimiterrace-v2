import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F10 (#46): AdvertiserCreateForm の**項目別インライン検証 (FormField)**。createAdvertiserAction と router を
 * mock し、(1) 空送信は会社名エラーで action を呼ばない (2) メール形式違反を項目別に出す (3) 入力で当該
 * エラーが消える (4) 正常入力で action を呼び一覧へ push (5) サーバ失敗は上部にエラー、を検証する。
 * 検証規則そのものは advertisers-core.test.ts (collectAdvertiserFieldErrors) で固定。
 */

const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));
vi.mock("@/lib/system-admin/advertisers-actions", () => ({ createAdvertiserAction: vi.fn() }));

import { AdvertiserCreateForm } from "../../app/admin/system/advertisers/new/_components/AdvertiserCreateForm";
import { createAdvertiserAction } from "../../lib/system-admin/advertisers-actions";

const createMock = vi.mocked(createAdvertiserAction);
const ADV_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("AdvertiserCreateForm 項目別検証", () => {
  it("空送信は会社名エラーを出し、action を呼ばない", () => {
    render(<AdvertiserCreateForm />);
    fireEvent.click(screen.getByRole("button", { name: "登録する" }));
    expect(createMock).not.toHaveBeenCalled();
    expect(screen.getByText(/会社名は 1〜200 文字/)).toBeInTheDocument();
  });

  it("メール形式違反を項目別に出す (会社名は正しいので会社名エラーは無し)", () => {
    render(<AdvertiserCreateForm />);
    fireEvent.change(screen.getByRole("textbox", { name: "会社名" }), {
      target: { value: "アクメ商事" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "担当メールアドレス" }), {
      target: { value: "not-an-email" },
    });
    fireEvent.click(screen.getByRole("button", { name: "登録する" }));
    expect(createMock).not.toHaveBeenCalled();
    expect(screen.getByText(/メールアドレスの形式が正しくありません/)).toBeInTheDocument();
    expect(screen.queryByText(/会社名は/)).toBeNull();
  });

  it("項目を入力すると当該エラーが消える", () => {
    render(<AdvertiserCreateForm />);
    fireEvent.click(screen.getByRole("button", { name: "登録する" }));
    expect(screen.getByText(/会社名は 1〜200 文字/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "会社名" }), {
      target: { value: "アクメ商事" },
    });
    expect(screen.queryByText(/会社名は 1〜200 文字/)).toBeNull();
  });

  it("正常入力で createAdvertiserAction を呼び、一覧へ push する", async () => {
    createMock.mockResolvedValue({ ok: true, data: { id: ADV_ID } });
    render(<AdvertiserCreateForm />);
    fireEvent.change(screen.getByRole("textbox", { name: "会社名" }), {
      target: { value: "アクメ商事" },
    });
    fireEvent.click(screen.getByRole("button", { name: "登録する" }));
    await waitFor(() =>
      expect(createMock).toHaveBeenCalledWith({
        companyName: "アクメ商事",
        industry: "",
        contactEmail: "",
        contactPhone: "",
        address: "",
        notes: "",
        status: "prospect",
      }),
    );
    await waitFor(() => expect(push).toHaveBeenCalledWith("/admin/system/advertisers"));
  });

  it("サーバ失敗時は上部にエラーを表示し push しない", async () => {
    createMock.mockResolvedValue({
      ok: false,
      error: { code: "conflict", message: "同名の広告主が既に存在します。" },
    });
    render(<AdvertiserCreateForm />);
    fireEvent.change(screen.getByRole("textbox", { name: "会社名" }), {
      target: { value: "アクメ商事" },
    });
    fireEvent.click(screen.getByRole("button", { name: "登録する" }));
    expect(await screen.findByText("同名の広告主が既に存在します。")).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });
});
