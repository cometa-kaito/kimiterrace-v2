import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F10 (#46): ContractCreateForm のテスト。createContractAction と router を mock し、入力値 +
 * advertiserId で action を呼ぶこと・成功で refresh・失敗でエラー表示 (refresh しない)・status 選択を検証。
 */

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/lib/system-admin/contracts-actions", () => ({ createContractAction: vi.fn() }));

import { ContractCreateForm } from "../../app/admin/system/advertisers/[id]/contracts/_components/ContractCreateForm";
import { createContractAction } from "../../lib/system-admin/contracts-actions";

const createMock = vi.mocked(createContractAction);
const ADV_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONTRACT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

function fillRequired() {
  fireEvent.change(screen.getByLabelText(/開始日/), { target: { value: "2026-04-01" } });
  fireEvent.change(screen.getByLabelText(/月額/), { target: { value: "50000" } });
}

describe("ContractCreateForm (#46 契約作成フォーム)", () => {
  it("送信で入力値 + advertiserId を渡して action を呼ぶ → 成功で refresh", async () => {
    createMock.mockResolvedValue({ ok: true, data: { id: CONTRACT_ID } });
    render(<ContractCreateForm advertiserId={ADV_ID} />);
    fillRequired();
    fireEvent.click(screen.getByRole("button", { name: "契約を登録" }));
    await waitFor(() =>
      expect(createMock).toHaveBeenCalledWith(
        expect.objectContaining({
          advertiserId: ADV_ID,
          status: "draft",
          startedAt: "2026-04-01",
          monthlyFeeJpy: "50000",
        }),
      ),
    );
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("ステータスを選んで送信できる (active)", async () => {
    createMock.mockResolvedValue({ ok: true, data: { id: CONTRACT_ID } });
    render(<ContractCreateForm advertiserId={ADV_ID} />);
    fireEvent.change(screen.getByLabelText(/ステータス/), { target: { value: "active" } });
    fillRequired();
    fireEvent.click(screen.getByRole("button", { name: "契約を登録" }));
    await waitFor(() =>
      expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ status: "active" })),
    );
  });

  it("失敗時はエラーメッセージを表示し refresh しない", async () => {
    createMock.mockResolvedValue({
      ok: false,
      error: { code: "invalid", message: "月額の指定が不正です(テスト)" },
    });
    render(<ContractCreateForm advertiserId={ADV_ID} />);
    fillRequired();
    fireEvent.click(screen.getByRole("button", { name: "契約を登録" }));
    await screen.findByText("月額の指定が不正です(テスト)");
    expect(refresh).not.toHaveBeenCalled();
  });
});
