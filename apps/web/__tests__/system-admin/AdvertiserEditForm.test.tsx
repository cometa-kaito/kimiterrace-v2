import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F10 (#46): AdvertiserEditForm の**項目別インライン検証 (FormField)** + 既定値・更新経路。
 * updateAdvertiserAction と router を mock し、(1) 既定値を埋め、必須を空にして送信すると項目エラーで送信を
 * 止める (2) メール形式違反を項目別に出す (3) 正常編集で id 付きで action を呼び一覧へ push、を検証する。
 * 検証規則そのものは advertisers-core.test.ts (collectAdvertiserFieldErrors) で固定。
 */

const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));
vi.mock("@/lib/system-admin/advertisers-actions", () => ({ updateAdvertiserAction: vi.fn() }));

import type { AdvertiserDetail } from "../../lib/system-admin/advertisers-queries";
import { AdvertiserEditForm } from "../../app/ops/advertisers/[id]/edit/_components/AdvertiserEditForm";
import { updateAdvertiserAction } from "../../lib/system-admin/advertisers-actions";

const updateMock = vi.mocked(updateAdvertiserAction);

const ADV: AdvertiserDetail = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  companyName: "アクメ商事",
  industry: "広告",
  contactEmail: "sales@acme.example",
  contactPhone: "03-1234-5678",
  address: "東京都",
  notes: "重要顧客",
  status: "active",
};

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("AdvertiserEditForm 項目別検証 + 更新", () => {
  it("既定値を埋め、会社名を空にして送信すると項目エラーで送信を止める", () => {
    render(<AdvertiserEditForm advertiser={ADV} />);
    const name = screen.getByRole("textbox", { name: "会社名" });
    expect(name).toHaveValue("アクメ商事"); // defaultValue
    fireEvent.change(name, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "保存する" }));
    expect(updateMock).not.toHaveBeenCalled();
    expect(screen.getByText(/会社名は 1〜200 文字/)).toBeInTheDocument();
  });

  it("メール形式違反は contactEmail 項目エラーで送信しない", () => {
    render(<AdvertiserEditForm advertiser={ADV} />);
    fireEvent.change(screen.getByRole("textbox", { name: "担当メールアドレス" }), {
      target: { value: "not-an-email" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存する" }));
    expect(updateMock).not.toHaveBeenCalled();
    expect(screen.getByText(/メールアドレスの形式が正しくありません/)).toBeInTheDocument();
  });

  it("正常編集で id 付きで updateAdvertiserAction を呼び、一覧へ push する", async () => {
    updateMock.mockResolvedValue({ ok: true, data: { id: ADV.id } });
    render(<AdvertiserEditForm advertiser={ADV} />);
    fireEvent.change(screen.getByRole("textbox", { name: "会社名" }), {
      target: { value: "アクメ商事株式会社" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存する" }));
    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith(ADV.id, {
        companyName: "アクメ商事株式会社",
        industry: "広告",
        contactEmail: "sales@acme.example",
        contactPhone: "03-1234-5678",
        address: "東京都",
        notes: "重要顧客",
        status: "active",
      }),
    );
    await waitFor(() => expect(push).toHaveBeenCalledWith("/ops/advertisers"));
  });
});
