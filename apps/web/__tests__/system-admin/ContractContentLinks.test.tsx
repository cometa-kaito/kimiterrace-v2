import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F10 (#46): ContractContentLinks のテスト。link/unlink action と router を mock。
 * 紐付け一覧の描画 (タイトル + 解除ボタン)・空表示・link フォーム送信 → refresh・unlink confirm 後の
 * action 呼び出し・confirm キャンセルで未送信・失敗時のエラー表示を検証。
 */

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/lib/system-admin/contract-contents-actions", () => ({
  linkContentToContractAction: vi.fn(),
  unlinkContentFromContractAction: vi.fn(),
}));

import { ContractContentLinks } from "../../app/admin/system/advertisers/[id]/contracts/_components/ContractContentLinks";
import {
  linkContentToContractAction,
  unlinkContentFromContractAction,
} from "../../lib/system-admin/contract-contents-actions";

const linkMock = vi.mocked(linkContentToContractAction);
const unlinkMock = vi.mocked(unlinkContentFromContractAction);

const CONTRACT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ADV_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONTENT_ID = "11111111-1111-4111-8111-111111111111";
const LINK_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const links = [{ linkId: LINK_ID, contentId: CONTENT_ID, title: "体育祭ポスター", schoolId: "s1" }];

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("ContractContentLinks (#46 出稿コンテンツ紐付け)", () => {
  it("紐付け一覧を描画する (タイトル + 解除ボタン、テキスト = 色非依存)", () => {
    render(<ContractContentLinks contractId={CONTRACT_ID} advertiserId={ADV_ID} links={links} />);
    expect(screen.getByText("体育祭ポスター")).toBeTruthy();
    // aria-label でテキストアクセシブル (NFR05)。
    expect(screen.getByRole("button", { name: /体育祭ポスター の紐付けを解除/ })).toBeTruthy();
  });

  it("紐付けが空のときは案内文を出す", () => {
    render(<ContractContentLinks contractId={CONTRACT_ID} advertiserId={ADV_ID} links={[]} />);
    expect(screen.getByText("紐付いた出稿コンテンツはありません。")).toBeTruthy();
  });

  it("link フォーム送信: contentId 付きで action を呼び refresh", async () => {
    linkMock.mockResolvedValue({ ok: true, data: { id: LINK_ID } });
    render(<ContractContentLinks contractId={CONTRACT_ID} advertiserId={ADV_ID} links={[]} />);
    fireEvent.change(screen.getByPlaceholderText(/00000000/), { target: { value: CONTENT_ID } });
    fireEvent.click(screen.getByRole("button", { name: /紐付ける/ }));
    await waitFor(() =>
      expect(linkMock).toHaveBeenCalledWith({
        contractId: CONTRACT_ID,
        contentId: CONTENT_ID,
        advertiserId: ADV_ID,
      }),
    );
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("unlink: confirm 後に linkId で action を呼び refresh", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    unlinkMock.mockResolvedValue({ ok: true, data: { id: LINK_ID } });
    render(<ContractContentLinks contractId={CONTRACT_ID} advertiserId={ADV_ID} links={links} />);
    fireEvent.click(screen.getByRole("button", { name: /体育祭ポスター の紐付けを解除/ }));
    await waitFor(() =>
      expect(unlinkMock).toHaveBeenCalledWith({ linkId: LINK_ID, advertiserId: ADV_ID }),
    );
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("unlink: confirm キャンセルで action を呼ばない", () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<ContractContentLinks contractId={CONTRACT_ID} advertiserId={ADV_ID} links={links} />);
    fireEvent.click(screen.getByRole("button", { name: /体育祭ポスター の紐付けを解除/ }));
    expect(unlinkMock).not.toHaveBeenCalled();
  });

  it("link 失敗時はエラーメッセージを表示し refresh しない", async () => {
    linkMock.mockResolvedValue({
      ok: false,
      error: { code: "conflict", message: "既に紐付いています(テスト)" },
    });
    render(<ContractContentLinks contractId={CONTRACT_ID} advertiserId={ADV_ID} links={[]} />);
    fireEvent.change(screen.getByPlaceholderText(/00000000/), { target: { value: CONTENT_ID } });
    fireEvent.click(screen.getByRole("button", { name: /紐付ける/ }));
    await screen.findByText("既に紐付いています(テスト)");
    expect(refresh).not.toHaveBeenCalled();
  });
});
