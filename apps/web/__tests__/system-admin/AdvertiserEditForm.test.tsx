import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F10 (#46) / 実装設計書 §4「最小縮退」: AdvertiserEditForm は **表示名 + 配信ステータス (稼働中 / 休止)** の
 * 2 項目に縮退した。updateAdvertiserAction と router を mock し、(1) 表示名の既定値・空送信の項目エラー停止
 * (2) 配信ステータスの既定選択 (3) 正常編集で id + {companyName, status} で action を呼び一覧へ push、を検証する。
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
  status: "active",
};

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("AdvertiserEditForm 最小縮退 (表示名 + 配信ステータス)", () => {
  it("表示名は既定値を埋め、空にして送信すると項目エラーで送信を止める", () => {
    render(<AdvertiserEditForm advertiser={ADV} />);
    const name = screen.getByRole("textbox", { name: "表示名" });
    expect(name).toHaveValue("アクメ商事"); // defaultValue
    fireEvent.change(name, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "保存する" }));
    expect(updateMock).not.toHaveBeenCalled();
    expect(screen.getByText(/会社名は 1〜200 文字/)).toBeInTheDocument();
  });

  it("配信ステータスは現在値 (稼働中) を初期選択する", () => {
    render(<AdvertiserEditForm advertiser={ADV} />);
    expect(screen.getByRole("combobox", { name: "配信ステータス" })).toHaveValue("active");
  });

  it("休止中 (paused) の広告主は配信ステータスが休止で初期選択される", () => {
    render(<AdvertiserEditForm advertiser={{ ...ADV, status: "paused" }} />);
    expect(screen.getByRole("combobox", { name: "配信ステータス" })).toHaveValue("paused");
  });

  it("見込み (prospect) の広告主は稼働中扱いで初期選択される (不変条件)", () => {
    render(<AdvertiserEditForm advertiser={{ ...ADV, status: "prospect" }} />);
    expect(screen.getByRole("combobox", { name: "配信ステータス" })).toHaveValue("active");
  });

  it("正常編集で id + {companyName, status} で updateAdvertiserAction を呼び、一覧へ push する", async () => {
    updateMock.mockResolvedValue({ ok: true, data: { id: ADV.id } });
    render(<AdvertiserEditForm advertiser={ADV} />);
    fireEvent.change(screen.getByRole("textbox", { name: "表示名" }), {
      target: { value: "アクメ商事株式会社" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "配信ステータス" }), {
      target: { value: "paused" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存する" }));
    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith(ADV.id, {
        companyName: "アクメ商事株式会社",
        status: "paused",
      }),
    );
    await waitFor(() => expect(push).toHaveBeenCalledWith("/ops/advertisers"));
  });
});
