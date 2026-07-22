import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * 「設定・取り込み」メニュー（PlanToolsMenu）を固定する。頻度の低い 3 操作（基本時間割 / 年間予定表 /
 * 写真取込）を 1 つのポップオーバーに畳む導線（2026-07-22・盤面直下の情報過多解消）。
 * - 既定は閉じている（パネル / 各項目は DOM に出さない＝盤面の一等地を静かに保つ）
 * - トリガーで開くと項目が現れる。表示条件（週次時間割の有無・AI 有効）は親が prop で渡す＝死リンク防止
 * - Escape で閉じる（キーボード操作の巡回）
 * OCR/受け渡しの実体は photo-import-zone.test.tsx / photo-import-actions.test.ts が担当（ここは action をモック）。
 */

vi.mock("../../lib/editor/photo-import-actions", () => ({
  photoImportChatMessageAction: vi.fn(),
}));

import { PlanToolsMenu } from "../../app/app/editor/[classId]/_components/PlanToolsMenu";
import { PhotoImportProvider } from "../../app/app/editor/[classId]/_components/photo-import-context";

function renderMenu(
  props: Partial<{
    showTimetableLink: boolean;
    showPhotoImport: boolean;
  }> = {},
) {
  return render(
    <PhotoImportProvider>
      <PlanToolsMenu
        classId="c1"
        calendarImportPath="/app/editor/c1/calendar-import"
        showTimetableLink={props.showTimetableLink ?? true}
        showPhotoImport={props.showPhotoImport ?? true}
      />
    </PhotoImportProvider>,
  );
}

function openMenu() {
  fireEvent.click(screen.getByRole("button", { name: /設定・取り込み/ }));
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("PlanToolsMenu", () => {
  it("既定は閉じている（トリガーだけ・項目は DOM に出さない）", () => {
    renderMenu();
    expect(screen.getByRole("button", { name: /設定・取り込み/ })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("link", { name: "年間予定表を取り込む" })).toBeNull();
  });

  it("開くと 3 操作が現れる（基本時間割 / 年間予定表 / 写真取込）", () => {
    renderMenu({ showTimetableLink: true, showPhotoImport: true });
    openMenu();
    expect(screen.getByRole("dialog")).toBeTruthy();
    const timetable = screen.getByRole("link", { name: "基本時間割を設定" });
    expect(timetable.getAttribute("href")).toBe("/app/editor/c1/timetable");
    const calendar = screen.getByRole("link", { name: "年間予定表を取り込む" });
    expect(calendar.getAttribute("href")).toBe("/app/editor/c1/calendar-import");
    expect(screen.getByRole("button", { name: /プリント\/写真から取り込む/ })).toBeTruthy();
  });

  it("週次時間割が無い学級では「基本時間割を設定」を出さない（死リンク防止）", () => {
    renderMenu({ showTimetableLink: false });
    openMenu();
    expect(screen.queryByRole("link", { name: "基本時間割を設定" })).toBeNull();
    // 年間予定表は常に出す（行事 0 件の学級にも初回導線を保証）。
    expect(screen.getByRole("link", { name: "年間予定表を取り込む" })).toBeTruthy();
  });

  it("AI 無効環境では写真取込導線を出さない（設計 D7・prod 既定）", () => {
    renderMenu({ showPhotoImport: false });
    openMenu();
    expect(screen.queryByRole("button", { name: /プリント\/写真から取り込む/ })).toBeNull();
  });

  it("Escape で閉じる", () => {
    renderMenu();
    openMenu();
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
