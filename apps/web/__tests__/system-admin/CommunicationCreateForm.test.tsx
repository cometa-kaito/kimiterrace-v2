import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F10 (#46): CommunicationCreateForm のテスト。createCommunicationAction と router を mock し、入力値 +
 * advertiserId で action を呼ぶこと・occurredAt を JST (+09:00) 明示 timezone へ正規化すること・成功で
 * refresh・失敗でエラー表示 (refresh しない)・チャネル選択を検証する (ContractCreateForm.test と同方針)。
 */

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/lib/system-admin/communications-actions", () => ({
  createCommunicationAction: vi.fn(),
}));

import { CommunicationCreateForm } from "../../app/admin/system/advertisers/[id]/communications/_components/CommunicationCreateForm";
import { createCommunicationAction } from "../../lib/system-admin/communications-actions";

const createMock = vi.mocked(createCommunicationAction);
const ADV_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COMM_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

function fillRequired() {
  fireEvent.change(screen.getByLabelText(/発生日時/), { target: { value: "2026-04-01T10:30" } });
  fireEvent.change(screen.getByLabelText(/件名/), { target: { value: "初回商談" } });
}

describe("CommunicationCreateForm (#46 コミュニケーション作成フォーム)", () => {
  it("送信で入力値 + advertiserId を渡して action を呼ぶ → occurredAt は JST 明示 tz・成功で refresh", async () => {
    createMock.mockResolvedValue({ ok: true, data: { id: COMM_ID } });
    render(<CommunicationCreateForm advertiserId={ADV_ID} />);
    fillRequired();
    fireEvent.click(screen.getByRole("button", { name: "履歴を登録" }));
    await waitFor(() =>
      expect(createMock).toHaveBeenCalledWith(
        expect.objectContaining({
          advertiserId: ADV_ID,
          channel: "email",
          occurredAt: "2026-04-01T10:30:00+09:00",
          subject: "初回商談",
        }),
      ),
    );
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("チャネルを選んで送信できる (phone)", async () => {
    createMock.mockResolvedValue({ ok: true, data: { id: COMM_ID } });
    render(<CommunicationCreateForm advertiserId={ADV_ID} />);
    fireEvent.change(screen.getByLabelText(/チャネル/), { target: { value: "phone" } });
    fillRequired();
    fireEvent.click(screen.getByRole("button", { name: "履歴を登録" }));
    await waitFor(() =>
      expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ channel: "phone" })),
    );
  });

  it("失敗時はエラーメッセージを表示し refresh しない", async () => {
    createMock.mockResolvedValue({
      ok: false,
      error: { code: "invalid", message: "件名は 1〜300 文字で入力してください。(テスト)" },
    });
    render(<CommunicationCreateForm advertiserId={ADV_ID} />);
    fillRequired();
    fireEvent.click(screen.getByRole("button", { name: "履歴を登録" }));
    await screen.findByText("件名は 1〜300 文字で入力してください。(テスト)");
    expect(refresh).not.toHaveBeenCalled();
  });
});
