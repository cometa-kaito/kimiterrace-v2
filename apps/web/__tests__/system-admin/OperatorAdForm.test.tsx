import { ToastProvider } from "@kimiterrace/ui";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F10 / #46: OperatorAdForm の検証。createOperatorAdAction と router を mock。学校未選択 / 不正メディア
 * URL は送信せずエラー、正常入力で action を反転値で呼び成功トースト、を検証する。
 */

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/lib/system-admin/operator-ads-actions", () => ({ createOperatorAdAction: vi.fn() }));

import { OperatorAdForm } from "../../app/admin/system/advertisers/[id]/ads/_components/OperatorAdForm";
import { createOperatorAdAction } from "../../lib/system-admin/operator-ads-actions";

const createMock = vi.mocked(createOperatorAdAction);
const ADV_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SCHOOL_ID = "22222222-2222-4222-8222-222222222222";
const SCHOOLS = [{ id: SCHOOL_ID, name: "岐南工業高校", prefecture: "岐阜県" }];

function renderForm() {
  return render(
    <ToastProvider>
      <OperatorAdForm advertiserId={ADV_ID} schools={SCHOOLS} />
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("OperatorAdForm", () => {
  it("学校未選択は送信せずエラー", () => {
    renderForm();
    fireEvent.change(screen.getByRole("textbox", { name: /メディア URL/ }), {
      target: { value: "https://cdn.example.com/a.png" },
    });
    fireEvent.click(screen.getByRole("button", { name: "入稿する" }));
    expect(createMock).not.toHaveBeenCalled();
    expect(screen.getByText(/学校を選択してください/)).toBeInTheDocument();
  });

  it("不正なメディア URL は送信せずエラー (validateAdInput 流用)", () => {
    renderForm();
    fireEvent.change(screen.getByRole("combobox", { name: /表示する学校/ }), {
      target: { value: SCHOOL_ID },
    });
    fireEvent.change(screen.getByRole("textbox", { name: /メディア URL/ }), {
      target: { value: "not-a-url" },
    });
    fireEvent.click(screen.getByRole("button", { name: "入稿する" }));
    expect(createMock).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("http(s) の URL を入力してください");
  });

  it("正常入力で createOperatorAdAction を反転値で呼ぶ", async () => {
    createMock.mockResolvedValue({ ok: true, data: { id: "new-1" } });
    renderForm();
    fireEvent.change(screen.getByRole("combobox", { name: /表示する学校/ }), {
      target: { value: SCHOOL_ID },
    });
    fireEvent.change(screen.getByRole("textbox", { name: /メディア URL/ }), {
      target: { value: "https://cdn.example.com/a.png" },
    });
    fireEvent.click(screen.getByRole("button", { name: "入稿する" }));
    await waitFor(() =>
      expect(createMock).toHaveBeenCalledWith({
        advertiserId: ADV_ID,
        schoolId: SCHOOL_ID,
        mediaUrl: "https://cdn.example.com/a.png",
        mediaType: "image",
        durationSec: "10",
        linkUrl: "",
        caption: "",
      }),
    );
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("サーバ失敗時はエラーを表示する", async () => {
    createMock.mockResolvedValue({
      ok: false,
      error: { code: "not_found", message: "指定された学校が見つかりません。" },
    });
    renderForm();
    fireEvent.change(screen.getByRole("combobox", { name: /表示する学校/ }), {
      target: { value: SCHOOL_ID },
    });
    fireEvent.change(screen.getByRole("textbox", { name: /メディア URL/ }), {
      target: { value: "https://cdn.example.com/a.png" },
    });
    fireEvent.click(screen.getByRole("button", { name: "入稿する" }));
    expect(await screen.findByText("指定された学校が見つかりません。")).toBeInTheDocument();
  });
});
