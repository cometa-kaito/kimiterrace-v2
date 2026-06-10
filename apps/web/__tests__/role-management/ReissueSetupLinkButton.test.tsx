import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F11 (#324 follow-up B1): ReissueSetupLinkButton のテスト。reissueStaffSetupLinkAction を mock し、
 * 押下で userId を渡して action を呼ぶこと・成功で**再発行リンクをオーバーレイ提示**すること・コピー操作・
 * 失敗のエラー表示・閉じるでリンクを破棄することを検証。認可/RLS/IdP/監査は Server Action 側の責務なので、
 * ここは UI 配線のみ固める (StaffCreateForm.test と同方針)。
 */

vi.mock("@/lib/role-management/member-actions", () => ({ reissueStaffSetupLinkAction: vi.fn() }));

import { ReissueSetupLinkButton } from "../../app/admin/school/members/_components/ReissueSetupLinkButton";
import { reissueStaffSetupLinkAction } from "../../lib/role-management/member-actions";

const reissueMock = vi.mocked(reissueStaffSetupLinkAction);

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

const PROPS = { userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", displayName: "山田先生" };

describe("ReissueSetupLinkButton (#324 follow-up B1)", () => {
  it("押下で {userId} を渡して action を呼ぶ", async () => {
    reissueMock.mockResolvedValue({
      ok: true,
      data: { id: PROPS.userId, setupLink: "https://app.example/reset-password?oobCode=abc" },
    });
    render(<ReissueSetupLinkButton {...PROPS} />);
    fireEvent.click(screen.getByRole("button", { name: "設定リンク再発行" }));
    await waitFor(() => expect(reissueMock).toHaveBeenCalledWith({ userId: PROPS.userId }));
  });

  it("成功で再発行リンクをオーバーレイに表示する", async () => {
    reissueMock.mockResolvedValue({
      ok: true,
      data: { id: PROPS.userId, setupLink: "https://app.example/reset-password?oobCode=abc" },
    });
    render(<ReissueSetupLinkButton {...PROPS} />);
    fireEvent.click(screen.getByRole("button", { name: "設定リンク再発行" }));
    const linkInput = await screen.findByLabelText("初回パスワード設定リンク");
    expect(linkInput).toHaveValue("https://app.example/reset-password?oobCode=abc");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("コピーボタンで setupLink をクリップボードへ書き込む", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    reissueMock.mockResolvedValue({
      ok: true,
      data: { id: PROPS.userId, setupLink: "https://app.example/reset-password?oobCode=xyz" },
    });
    render(<ReissueSetupLinkButton {...PROPS} />);
    fireEvent.click(screen.getByRole("button", { name: "設定リンク再発行" }));
    const copyBtn = await screen.findByRole("button", { name: "リンクをコピー" });
    fireEvent.click(copyBtn);
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("https://app.example/reset-password?oobCode=xyz"),
    );
  });

  it("clipboard 失敗時は手動コピー誘導を出す (B2 回避)", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.assign(navigator, { clipboard: { writeText } });
    reissueMock.mockResolvedValue({
      ok: true,
      data: { id: PROPS.userId, setupLink: "https://app.example/reset-password?oobCode=xyz" },
    });
    render(<ReissueSetupLinkButton {...PROPS} />);
    fireEvent.click(screen.getByRole("button", { name: "設定リンク再発行" }));
    fireEvent.click(await screen.findByRole("button", { name: "リンクをコピー" }));
    await screen.findByText(/自動コピーできませんでした/);
  });

  it("失敗時はエラーを表示し、リンクオーバーレイを出さない", async () => {
    reissueMock.mockResolvedValue({
      ok: false,
      error: {
        code: "conflict",
        message: "無効化されたアカウントです。先に再有効化してから再発行してください。",
      },
    });
    render(<ReissueSetupLinkButton {...PROPS} />);
    fireEvent.click(screen.getByRole("button", { name: "設定リンク再発行" }));
    await screen.findByText("無効化されたアカウントです。先に再有効化してから再発行してください。");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("初回パスワード設定リンク")).not.toBeInTheDocument();
  });

  it("閉じるでリンクを破棄する (secret を画面に残さない)", async () => {
    reissueMock.mockResolvedValue({
      ok: true,
      data: { id: PROPS.userId, setupLink: "https://app.example/reset-password?oobCode=abc" },
    });
    render(<ReissueSetupLinkButton {...PROPS} />);
    fireEvent.click(screen.getByRole("button", { name: "設定リンク再発行" }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.queryByLabelText("初回パスワード設定リンク")).not.toBeInTheDocument();
  });

  it("Esc でオーバーレイを閉じる (a11y: secret も破棄する)", async () => {
    reissueMock.mockResolvedValue({
      ok: true,
      data: { id: PROPS.userId, setupLink: "https://app.example/reset-password?oobCode=abc" },
    });
    render(<ReissueSetupLinkButton {...PROPS} />);
    fireEvent.click(screen.getByRole("button", { name: "設定リンク再発行" }));
    await screen.findByRole("dialog");
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.queryByLabelText("初回パスワード設定リンク")).not.toBeInTheDocument();
  });
});
