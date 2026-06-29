import type { TvSchedule } from "@kimiterrace/db/tv-schedule";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TvConfigEditForm } from "@/app/ops/tv-devices/[deviceId]/edit/_components/TvConfigEditForm";

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

  it("非 http(s) URL ではプレビューリンクを出さない（javascript: 等の href sink を塞ぐ）", () => {
    // 保存時は checkEditableUrl が弾くが、保存前の未検証入力が href に載らないことを固定する。
    renderForm("javascript:alert(1)");
    expect(screen.queryByRole("link", { name: /プレビューを開く/ })).toBeNull();
    expect(screen.getByText(/http\(s\) の URL のみ開けます/)).toBeInTheDocument();
  });
});

function renderWithSchedule(schedule: TvSchedule | null) {
  return render(
    <TvConfigEditForm
      deviceRowId="11111111-1111-1111-1111-111111111111"
      deviceId="DEV-1"
      initial={{
        label: "1年1組",
        targetMac: null,
        signageUrl: null,
        webhookUrl: null,
        schedule,
        monitoringEnabled: true,
        notes: null,
      }}
      currentVersion={1}
    />,
  );
}

describe("TvConfigEditForm 表示時間帯（分単位・複数窓）", () => {
  it("スケジュール無しは空の時間帯行を 1 つ表示", () => {
    renderWithSchedule(null);
    expect(screen.getByLabelText("時間帯1 点灯時刻")).toBeInTheDocument();
    expect(screen.getByLabelText("時間帯1 消灯時刻")).toBeInTheDocument();
    expect(screen.queryByLabelText("時間帯2 点灯時刻")).toBeNull();
  });

  it("複数窓スケジュールは各窓を別々の行（HH:MM）で表示する", () => {
    renderWithSchedule({
      enabled: true,
      windows: [
        { onHour: 8, onMinute: 0, offHour: 12, offMinute: 0 },
        { onHour: 13, onMinute: 30, offHour: 17, offMinute: 0 },
      ],
    });
    expect((screen.getByLabelText("時間帯1 点灯時刻") as HTMLInputElement).value).toBe("08:00");
    expect((screen.getByLabelText("時間帯1 消灯時刻") as HTMLInputElement).value).toBe("12:00");
    expect((screen.getByLabelText("時間帯2 点灯時刻") as HTMLInputElement).value).toBe("13:30");
    expect((screen.getByLabelText("時間帯2 消灯時刻") as HTMLInputElement).value).toBe("17:00");
  });

  it("「時間帯を追加」で行が増える", () => {
    renderWithSchedule(null);
    fireEvent.click(screen.getByRole("button", { name: /時間帯を追加/ }));
    expect(screen.getByLabelText("時間帯2 点灯時刻")).toBeInTheDocument();
  });

  it("削除で行が減る", () => {
    renderWithSchedule({
      enabled: true,
      windows: [
        { onHour: 8, onMinute: 0, offHour: 12, offMinute: 0 },
        { onHour: 13, onMinute: 0, offHour: 17, offMinute: 0 },
      ],
    });
    expect(screen.getByLabelText("時間帯2 点灯時刻")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("時間帯2を削除"));
    expect(screen.queryByLabelText("時間帯2 点灯時刻")).toBeNull();
    // 残った行は先頭窓の値を保持
    expect((screen.getByLabelText("時間帯1 点灯時刻") as HTMLInputElement).value).toBe("08:00");
  });
});
