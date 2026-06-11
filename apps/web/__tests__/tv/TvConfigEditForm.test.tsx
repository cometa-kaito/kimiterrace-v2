import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TvConfigEditForm } from "@/app/admin/tv-devices/[deviceId]/edit/_components/TvConfigEditForm";

/**
 * TV 設定編集フォームの「配信される URL」プレビュー（端末別デザイン切替の可視フィードバック）。
 * バグ修正の回帰防止: デザインを変えても URL 欄（素の URL 表示）は変わらないため「変更できていない」ように
 * 見えていた。選択中デザインを反映した配信 URL を表示し、開く/コピーできることを固定する。
 */

vi.mock("@/lib/tv/config-edit-actions", () => ({
  updateTvDeviceConfigAction: vi.fn(async () => ({ ok: true, data: { id: "d1", version: 2 } })),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const BASE = "https://app.school-signage.net/signage/TOK123";

function renderForm(signageUrl: string | null) {
  return render(
    <TvConfigEditForm
      deviceRowId="11111111-1111-1111-1111-111111111111"
      deviceId="DEV-1"
      initial={{
        label: "1年1組",
        targetMac: null,
        signageUrl,
        webhookUrl: null,
        schedule: null,
        monitoringEnabled: true,
        notes: null,
      }}
      currentVersion={1}
    />,
  );
}

function previewLink(): HTMLAnchorElement {
  return screen.getByRole("link", { name: /プレビューを開く/ }) as HTMLAnchorElement;
}

describe("TvConfigEditForm 配信URLプレビュー（端末別デザイン）", () => {
  it("初期 pattern1: 配信 URL は素の URL（?design 無し）", () => {
    renderForm(BASE);
    expect(previewLink()).toHaveAttribute("href", BASE);
  });

  it("デザインを pattern2 にすると配信 URL に ?design=pattern2 が付く（保存前でも即反映）", () => {
    renderForm(BASE);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "pattern2" } });
    const expected = `${BASE}?design=pattern2`;
    expect(previewLink()).toHaveAttribute("href", expected);
    // 読み取り専用の配信 URL 欄にも反映（コピー/目視できる）。
    expect(screen.getByDisplayValue(expected)).toBeInTheDocument();
  });

  it("初期が ?design=pattern2 付き URL なら dropdown=pattern2・配信 URL も pattern2", () => {
    renderForm(`${BASE}?design=pattern2`);
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("pattern2");
    expect(previewLink()).toHaveAttribute("href", `${BASE}?design=pattern2`);
  });

  it("pattern2→pattern1 に戻すと ?design は外れる（後方互換）", () => {
    renderForm(`${BASE}?design=pattern2`);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "pattern1" } });
    expect(previewLink()).toHaveAttribute("href", BASE);
  });

  it("サイネージ URL が空ならプレビュー欄は出ない", () => {
    renderForm(null);
    expect(screen.queryByRole("link", { name: /プレビューを開く/ })).toBeNull();
  });
});
